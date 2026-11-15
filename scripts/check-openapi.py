#!/usr/bin/env python3
"""Offline validator for docs/openapi.json, ops/examples/snap.caddy, and examples/agent_batch_download.py.

Performs zero external network requests. Verifies:
1. OpenAPI 3.1.0 top-level metadata, paths, parameters, status codes, headers, and BearerAuth security;
2. Every internal $ref resolves cleanly with zero external/network $refs;
3. Exact structural & enum parity between docs/openapi.json and docs/schema/unified-v1/unified-v1.schema.json,
   backend/config/platforms.json, and the GET /api/stats StatsSnapshot contract;
4. Draft 2020-12 JSON Schema validity and fixture conformance (via jsonschema when installed,
   required when --require-jsonschema is passed in CI);
5. Caddy example per-path @api whitelist parity and 404 JSON catch-all ordering in ops/examples/snap.caddy;
6. Syntax compilation, stdlib-only import hygiene, 4-step extension determination priority order,
   and loopback 206 Range resume + manifest idempotency of examples/agent_batch_download.py.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
import re
import sys
import tempfile
import textwrap
import threading
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "docs/openapi.json"
AGENT_API_DOC_PATH = ROOT / "docs/AGENT-API.md"
DEPLOYMENT_DOC_PATH = ROOT / "docs/DEPLOYMENT.md"
CADDY_EXAMPLE_PATH = ROOT / "ops/examples/snap.caddy"
UNIFIED_SCHEMA_PATH = ROOT / "docs/schema/unified-v1/unified-v1.schema.json"
PLATFORMS_PATH = ROOT / "backend/config/platforms.json"
EXAMPLES_DIR = ROOT / "docs/schema/unified-v1/examples"
BATCH_EXAMPLE_PATH = ROOT / "examples/agent_batch_download.py"

EXPECTED_CADDY_API_WHITELIST = [
    "/api/downloads/tbvideo-result",
    "/api/parse",
    "/api/resolve",
    "/api/platforms",
    "/api/short_videos",
    "/api/douyin",
    "/api/ksjx",
    "/api/bilibili",
    "/api/xhsjx",
    "/api/toutiao",
    "/api/youtube/context",
    "/api/youtube/finalize",
    "/api/stats",
]

ALLOWED_EXAMPLE_STDLIB = {
    "__future__",
    "argparse",
    "concurrent",
    "concurrent.futures",
    "datetime",
    "hashlib",
    "json",
    "os",
    "pathlib",
    "random",
    "re",
    "shutil",
    "sys",
    "threading",
    "time",
    "typing",
    "urllib",
    "urllib.error",
    "urllib.parse",
    "urllib.request",
}

EXPECTED_PATHS = {"/api/platforms", "/api/parse", "/api/resolve", "/api/stats"}
EXPECTED_HISTOGRAM_BUCKETS = [
    "<=10", "<=50", "<=100", "<=250", "<=500",
    "<=1000", "<=2500", "<=5000", "<=10000", "<=30000", "+Inf",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def resolve_pointer(doc: dict, ref: str):
    require(ref.startswith("#/components/"), f"Disallowed non-component or external $ref: {ref}")
    cur = doc
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        require(isinstance(cur, dict) and part in cur, f"Unresolved $ref pointer: {ref}")
        cur = cur[part]
    return cur


def walk_nodes(value, path: str = "$"):
    if isinstance(value, dict):
        yield path, value
        for k, v in value.items():
            yield from walk_nodes(v, f"{path}.{k}")
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            yield from walk_nodes(item, f"{path}[{idx}]")


def _normalize_schema_pointer(ptr: str) -> str:
    if ptr.startswith("#/$defs/"):
        return "#/SCHEMA/" + ptr[len("#/$defs/") :]
    if ptr.startswith("#/components/schemas/"):
        return "#/SCHEMA/" + ptr[len("#/components/schemas/") :]
    return ptr


def normalize_for_parity(node):
    """Normalizes #/$defs/ vs #/components/schemas/ (including discriminator.mapping) and deduplicates enum lists."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str):
                out[k] = _normalize_schema_pointer(v)
            elif k == "discriminator" and isinstance(v, dict):
                disc = normalize_for_parity(v)
                if isinstance(disc.get("mapping"), dict):
                    disc["mapping"] = {
                        mk: (_normalize_schema_pointer(mv) if isinstance(mv, str) else mv)
                        for mk, mv in disc["mapping"].items()
                    }
                out[k] = disc
            elif k == "enum" and isinstance(v, list):
                deduped = []
                for item in v:
                    if item not in deduped:
                        deduped.append(item)
                out[k] = deduped
            else:
                out[k] = normalize_for_parity(v)
        return out
    if isinstance(node, list):
        return [normalize_for_parity(item) for item in node]
    return node


def rewrite_component_refs_to_defs(node):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str) and v.startswith("#/components/schemas/"):
                out[k] = "#/$defs/" + v[len("#/components/schemas/") :]
            elif k == "discriminator" and isinstance(v, dict):
                disc = rewrite_component_refs_to_defs(v)
                if isinstance(disc.get("mapping"), dict):
                    disc["mapping"] = {
                        mk: (
                            "#/$defs/" + mv[len("#/components/schemas/") :]
                            if isinstance(mv, str) and mv.startswith("#/components/schemas/")
                            else mv
                        )
                        for mk, mv in disc["mapping"].items()
                    }
                out[k] = disc
            else:
                out[k] = rewrite_component_refs_to_defs(v)
        return out
    if isinstance(node, list):
        return [rewrite_component_refs_to_defs(item) for item in node]
    return node


def check_openapi_structure(spec: dict, unified_schema: dict, platforms_cfg: list[dict]) -> int:
    require(spec.get("openapi") == "3.1.0", "openapi version must be exactly '3.1.0'")
    require(
        spec.get("jsonSchemaDialect") == "https://json-schema.org/draft/2020-12/schema",
        "jsonSchemaDialect must be Draft 2020-12",
    )
    require("$defs" not in spec, "openapi.json must not contain top-level $defs")
    require("#/$defs/" not in json.dumps(spec), "openapi.json must be completely #/$defs/-free")

    info = spec.get("info") or {}
    require(bool(info.get("title")) and bool(info.get("version")), "info.title and info.version are required")

    servers = spec.get("servers") or []
    require(len(servers) >= 1, "servers must contain at least one entry")
    for srv in servers:
        require(str(srv.get("url", "")).startswith("https://"), "public server URLs in openapi.json must use https://")

    # Check all $ref pointers, discriminator.mapping pointers, $defs absence, & enum uniqueness across the entire document
    ref_count = 0
    for loc, obj in walk_nodes(spec):
        require("$defs" not in obj, f"Disallowed $defs keyword in openapi.json at {loc}")
        if "$ref" in obj:
            ref = obj["$ref"]
            require(isinstance(ref, str) and "#/$defs/" not in ref, f"$ref at {loc} must be a $defs-free string")
            resolve_pointer(spec, ref)
            ref_count += 1
        if "discriminator" in obj:
            disc = obj["discriminator"]
            require(isinstance(disc, dict), f"discriminator at {loc} must be an object")
            mapping = disc.get("mapping")
            if mapping is not None:
                require(
                    isinstance(mapping, dict) and len(mapping) >= 1,
                    f"discriminator.mapping at {loc} must be a non-empty object",
                )
                for disc_key, target in mapping.items():
                    require(
                        isinstance(target, str) and "#/$defs/" not in target,
                        f"discriminator.mapping[{disc_key!r}] at {loc} must be a $defs-free pointer string",
                    )
                    resolve_pointer(spec, target)
                    ref_count += 1
        if "enum" in obj and isinstance(obj["enum"], list):
            enum_vals = obj["enum"]
            require(len(enum_vals) >= 1, f"Empty enum at {loc}")
            require(len(enum_vals) == len(set(map(json.dumps, enum_vals))), f"Duplicate enum values at {loc}")

    # Security scheme check
    sec_schemes = ((spec.get("components") or {}).get("securitySchemes")) or {}
    bearer = sec_schemes.get("BearerAuth") or {}
    require(bearer.get("type") == "http" and bearer.get("scheme") == "bearer", "BearerAuth must be http bearer")

    # Paths, operations, parameters, security, and responses
    paths = spec.get("paths") or {}
    require(set(paths.keys()) == EXPECTED_PATHS, f"paths must equal {sorted(EXPECTED_PATHS)}")

    operation_ids: set[str] = set()
    expected_params = {
        "/api/platforms": {("schema_version", True)},
        "/api/parse": {("schema_version", True), ("url", True), ("platform", False), ("debug", False)},
        "/api/resolve": {
            ("schema_version", True), ("url", True), ("item_id", True), ("platform", False), ("debug", False)
        },
        "/api/stats": {("schema_version", False)},
    }
    common_statuses = {"200", "400", "401", "405", "409", "429", "500"}
    parse_extra_statuses = {"403", "404", "502", "503", "504"}

    for path_name, path_item in paths.items():
        require(set(path_item.keys()) == {"get"}, f"{path_name} must expose GET only in public OpenAPI")
        op = path_item["get"]
        op_id = op.get("operationId")
        require(isinstance(op_id, str) and op_id and op_id not in operation_ids, f"Invalid/duplicate operationId on {path_name}")
        operation_ids.add(op_id)

        # Security requirement check
        sec = op.get("security")
        if path_name == "/api/stats":
            require(sec == [{"BearerAuth": []}], "/api/stats must strictly require BearerAuth without anonymous fallback")
        else:
            require(
                isinstance(sec, list) and {} in sec and {"BearerAuth": []} in sec,
                f"{path_name} must document optional BearerAuth ([{{}}, {{'BearerAuth': []}}])",
            )

        # Parameter check
        resolved_params = [resolve_pointer(spec, p["$ref"]) if "$ref" in p else p for p in (op.get("parameters") or [])]
        param_tuples = {(p["name"], bool(p.get("required"))) for p in resolved_params}
        require(
            param_tuples == expected_params[path_name],
            f"Parameter mismatch on {path_name}: got {param_tuples}, expected {expected_params[path_name]}",
        )
        for p in resolved_params:
            require(p.get("in") == "query", f"Parameter {p['name']} on {path_name} must have in='query'")

        # Status codes & 401/429 contract check
        responses = op.get("responses") or {}
        expected_codes = common_statuses | (parse_extra_statuses if path_name in {"/api/parse", "/api/resolve"} else set())
        require(
            set(responses.keys()) == expected_codes,
            f"Status codes mismatch on {path_name}: got {sorted(responses.keys())}, expected {sorted(expected_codes)}",
        )
        require(
            responses["401"].get("$ref") == "#/components/responses/UnauthorizedFailure",
            f"{path_name} 401 must reference UnauthorizedFailure",
        )
        require(
            responses["429"].get("$ref") == "#/components/responses/RateLimitedFailure",
            f"{path_name} 429 must reference RateLimitedFailure",
        )

    # Verify 429 Retry-After header & 401 INVALID_INPUT wire contract
    rate_resp = spec["components"]["responses"]["RateLimitedFailure"]
    require("Retry-After" in (rate_resp.get("headers") or {}), "RateLimitedFailure must declare Retry-After header")
    unauth_schema = spec["components"]["schemas"]["UnauthorizedError"]
    require(
        unauth_schema["properties"]["code"].get("const") == "INVALID_INPUT"
        and unauth_schema["properties"]["retryable"].get("const") is False,
        "401 UnauthorizedError must fix code='INVALID_INPUT' and retryable=false",
    )

    # Parity check with docs/schema/unified-v1/unified-v1.schema.json
    comp_schemas = spec["components"]["schemas"]
    unified_defs = unified_schema["$defs"]
    for def_name, def_body in unified_defs.items():
        require(def_name in comp_schemas, f"Missing unified-v1 $defs schema in openapi.json: {def_name}")
        lhs = normalize_for_parity(def_body)
        rhs = normalize_for_parity(comp_schemas[def_name])
        require(lhs == rhs, f"Schema drift detected between unified-v1.schema.json and openapi.json for {def_name}")

    # Parity check with backend/config/platforms.json + 6 optional Go-registered platforms
    optional_go_platforms = ["x", "youtube", "instagram", "facebook", "tumblr", "dailymotion"]
    platform_ids = [entry["id"] for entry in platforms_cfg] + optional_go_platforms
    require(len(set(platform_ids)) == 15, "Expected 15 distinct platform IDs across platforms.json + Go adapters")
    require(
        comp_schemas["PlatformQuery"]["enum"] == ["all", *platform_ids],
        "PlatformQuery enum does not match the 15 registered platform IDs",
    )
    all_cfg_caps = {cap for entry in platforms_cfg for cap in entry.get("capabilities", [])}
    require(
        all_cfg_caps <= set(comp_schemas["PlatformCapability"]["enum"]),
        "PlatformCapability enum is missing capability values from backend/config/platforms.json",
    )
    require(
        set(comp_schemas["StatsPlatform"]["enum"]) == {*platform_ids, "unknown"}
        and len(comp_schemas["StatsPlatform"]["enum"]) == 16,
        "StatsPlatform enum must match the 15 registered platforms + 'unknown'",
    )
    wire_error_codes = set(comp_schemas["APIError"]["properties"]["code"]["enum"])
    require(
        set(comp_schemas["StatsOutcomeCode"]["enum"]) == (wire_error_codes | {"OK", "UNAUTHORIZED"})
        and len(comp_schemas["StatsOutcomeCode"]["enum"]) == 13,
        "StatsOutcomeCode enum must equal {'OK', 'UNAUTHORIZED'} union all 11 APIError wire codes",
    )
    require(comp_schemas["StatsChannel"]["enum"] == ["anonymous", "owner"], "StatsChannel enum mismatch")
    require(
        comp_schemas["HistogramBuckets"]["required"] == EXPECTED_HISTOGRAM_BUCKETS
        and list(comp_schemas["HistogramBuckets"]["properties"].keys()) == EXPECTED_HISTOGRAM_BUCKETS,
        "HistogramBuckets keys/required do not match exact 11 Prometheus millisecond bounds",
    )
    require(
        comp_schemas["ShanghaiStatsSnapshot"]["properties"]["mode"]["enum"] == ["off", "direct", "pull"],
        "ShanghaiStatsSnapshot.mode enum must be ['off', 'direct', 'pull']",
    )
    require(
        comp_schemas["StatsSnapshot"]["required"] == [
            "started_at", "generated_at", "uptime_seconds",
            "requests", "cache", "admission", "ytdlp", "shanghai", "parse_latency_ms",
        ],
        "StatsSnapshot required fields mismatch",
    )
    return ref_count


def check_with_jsonschema(spec: dict, require_installed: bool) -> dict:
    try:
        from jsonschema import Draft202012Validator, FormatChecker
    except ImportError as exc:
        if require_installed:
            raise RuntimeError("jsonschema is required by --require-jsonschema") from exc
        return {"enabled": False, "validated_fixtures": 0}

    defs = rewrite_component_refs_to_defs(spec["components"]["schemas"])
    for name in defs:
        wrapper = {"$defs": defs, "$ref": f"#/$defs/{name}"}
        Draft202012Validator.check_schema(wrapper)

    def make_validator(target_name: str) -> Draft202012Validator:
        return Draft202012Validator(
            {"$defs": defs, "$ref": f"#/$defs/{target_name}"},
            format_checker=FormatChecker(),
        )

    success_val = make_validator("Success")
    failure_val = make_validator("Failure")
    catalog_val = make_validator("CatalogSuccess")
    stats_val = make_validator("StatsSuccess")
    unauth_val = make_validator("UnauthorizedErrorResponse")
    ratelimit_val = make_validator("RateLimitedErrorResponse")

    fixture_files = sorted(EXAMPLES_DIR.glob("*.json"))
    require(len(fixture_files) >= 20, "Expected unified-v1 example fixtures")
    for fpath in fixture_files:
        instance = json.loads(fpath.read_text(encoding="utf-8"))
        validator = success_val if instance.get("code") == "OK" else failure_val
        errs = list(validator.iter_errors(instance))
        require(not errs, f"OpenAPI Success/Failure schema rejected committed fixture {fpath.name}")

    # Synthetic positive & negative checks for 401, 429, /api/platforms, and /api/stats
    require(not list(unauth_val.iter_errors({
        "schema_version": "1.0",
        "code": "INVALID_INPUT",
        "error": {"code": "INVALID_INPUT", "message": "认证凭据无效", "retryable": False},
    })), "Valid 401 payload rejected")
    require(bool(list(unauth_val.iter_errors({
        "schema_version": "1.0",
        "code": "INVALID_INPUT",
        "error": {"code": "INVALID_INPUT", "message": "认证凭据无效", "retryable": True},
    }))), "Invalid retryable=true 401 payload must be rejected")

    require(not list(ratelimit_val.iter_errors({
        "schema_version": "1.0",
        "code": "RATE_LIMITED",
        "error": {"code": "RATE_LIMITED", "message": "解析请求过于频繁", "retryable": True, "retry_after_seconds": 5},
    })), "Valid 429 payload rejected")

    require(not list(catalog_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            "platforms": [{
                "id": "douyin",
                "name": "抖音",
                "site_url": "https://www.douyin.com/",
                "icon": "/platforms/douyin.png",
                "capabilities": ["video", "image"],
            }],
        },
    })), "Valid /api/platforms payload rejected")

    zero_hist = {
        "count": 0,
        "sum_ms": 0,
        "max_ms": 0,
        "buckets": {k: 0 for k in EXPECTED_HISTOGRAM_BUCKETS},
    }
    zero_cache_ch = {"hits": 0, "misses": 0, "singleflight_shared": 0, "uncacheable": 0}
    zero_pool = {
        "active": 0, "queued": 0, "concurrency_limit": 8, "queue_limit": 256,
        "waited": 0, "granted": 0, "timeout": 0, "full": 0, "canceled": 0,
        "wait_ms_total": 0, "wait_ms_max": 0,
    }
    zero_slot = {
        "acquired_count": 0, "wait_count": 0, "canceled_count": 0,
        "wait_ms_total": 0, "wait_ms_max": 0, "wait_ms": zero_hist,
    }
    zero_sh = {
        "hits": 0, "fallbacks": 0, "canceled": 0,
        "queue_waits": 0, "queue_granted": 0, "queue_timeouts": 0,
        "queue_wait_ms_total": 0, "queue_wait_ms_max": 0,
    }
    require(not list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            "started_at": "2026-11-15T00:00:00Z",
            "generated_at": "2026-11-15T00:05:00Z",
            "uptime_seconds": 300,
            "requests": {
                "total": 1,
                "by_channel": {"anonymous": 0, "owner": 1},
                "by_platform_code_channel": [
                    {"platform": "douyin", "code": "OK", "channel": "owner", "count": 1},
                ],
            },
            "cache": {
                "enabled": True, "entries": 1, "bytes": 512, "max_entries": 4096, "max_bytes": 67108864,
                "total": zero_cache_ch,
                "by_channel": {"anonymous": zero_cache_ch, "owner": zero_cache_ch},
            },
            "admission": {"fast": zero_pool, "slow": zero_pool, "owner": zero_pool},
            "ytdlp": {
                "enabled": True, "active": 0, "waiting": 0, "concurrency_limit": 2,
                "total": zero_slot,
                "by_channel": {"anonymous": zero_slot, "owner": zero_slot},
            },
            "shanghai": {
                "enabled": True, "mode": "pull", "waiting_workers": 3, "queued_tasks": 0, "pending_tasks": 0,
                "total": zero_sh,
                "by_channel": {"anonymous": zero_sh, "owner": zero_sh},
            },
            "parse_latency_ms": {
                "total": zero_hist,
                "by_channel": {"anonymous": zero_hist, "owner": zero_hist},
            },
        },
    })), "Valid /api/stats payload rejected")

    return {"enabled": True, "validated_fixtures": len(fixture_files) + 5 + validate_doc_json_blocks(
        success_val, failure_val, catalog_val, stats_val, unauth_val, ratelimit_val
    )}


def extract_markdown_json_blocks(md_path: Path) -> list[dict]:
    require(md_path.is_file(), f"Missing documentation file: {md_path}")
    text = md_path.read_text(encoding="utf-8")
    raw_blocks = re.findall(r"(?m)^[ \t>]*```json\n(.*?)\n[ \t>]*```[ \t]*$", text, re.S)
    require(len(raw_blocks) >= 5, f"Expected >= 5 JSON examples in {md_path.name}")
    parsed: list[dict] = []
    for raw in raw_blocks:
        cleaned = re.sub(r"(?m)^[ \t]*>[ \t]?", "", raw)
        parsed.append(json.loads(textwrap.dedent(cleaned)))
    return parsed


def validate_doc_json_blocks(
    success_val, failure_val, catalog_val, stats_val, unauth_val, ratelimit_val
) -> int:
    blocks = extract_markdown_json_blocks(AGENT_API_DOC_PATH)
    for idx, obj in enumerate(blocks):
        code = obj.get("code")
        if code == "OK" and "items" in (obj.get("data") or {}):
            errs = list(success_val.iter_errors(obj))
        elif code == "OK" and "platforms" in (obj.get("data") or {}):
            errs = list(catalog_val.iter_errors(obj))
        elif code == "OK" and "uptime_seconds" in (obj.get("data") or {}):
            errs = list(stats_val.iter_errors(obj))
        elif code == "RATE_LIMITED":
            errs = list(ratelimit_val.iter_errors(obj))
        elif code == "INVALID_INPUT" and (obj.get("error") or {}).get("retryable") is False:
            errs = list(unauth_val.iter_errors(obj))
        else:
            errs = list(failure_val.iter_errors(obj))
        require(not errs, f"AGENT-API.md JSON example #{idx} failed OpenAPI schema validation")
    return len(blocks)


def check_python_scripts() -> None:
    require(BATCH_EXAMPLE_PATH.is_file(), f"Missing example script: {BATCH_EXAMPLE_PATH}")
    with tempfile.TemporaryDirectory(prefix="dokitool-openapi-pyc-") as tmp:
        for script in (BATCH_EXAMPLE_PATH, Path(__file__).resolve()):
            cfile = Path(tmp) / (script.stem + ".pyc")
            py_compile.compile(str(script), cfile=str(cfile), doraise=True)

    source = BATCH_EXAMPLE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(BATCH_EXAMPLE_PATH))
    stdlib_names = getattr(sys, "stdlib_module_names", None)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                allowed = (top in stdlib_names) if stdlib_names is not None else (alias.name in ALLOWED_EXAMPLE_STDLIB)
                require(allowed and alias.name in ALLOWED_EXAMPLE_STDLIB, f"Non-stdlib import in example: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            require(node.level == 0 and bool(node.module), "Relative imports are forbidden in standalone example")
            mod = node.module or ""
            top = mod.split(".")[0]
            allowed = (top in stdlib_names) if stdlib_names is not None else (mod in ALLOWED_EXAMPLE_STDLIB)
            require(allowed and mod in ALLOWED_EXAMPLE_STDLIB, f"Non-stdlib from-import in example: {mod}")


def check_caddy_whitelist() -> int:
    require(CADDY_EXAMPLE_PATH.is_file(), f"Missing Caddy example: {CADDY_EXAMPLE_PATH}")
    caddy = CADDY_EXAMPLE_PATH.read_text(encoding="utf-8")

    match = re.search(r"(?m)^\s*@api\s+path\s+(.+?)\s*$", caddy)
    require(match is not None, "ops/examples/snap.caddy must declare '@api path ...'")
    api_paths = match.group(1).split()
    require("/api/*" not in api_paths, "ops/examples/snap.caddy @api must not use wildcard /api/*")
    require(
        api_paths == EXPECTED_CADDY_API_WHITELIST,
        f"ops/examples/snap.caddy @api whitelist mismatch: got {api_paths}, expected {EXPECTED_CADDY_API_WHITELIST}",
    )
    require(
        EXPECTED_PATHS <= set(api_paths),
        "Every documented OpenAPI path must be included in ops/examples/snap.caddy @api whitelist",
    )
    require(
        "# Preserve ordering: Caddy otherwise sorts handle before route." in caddy,
        "ops/examples/snap.caddy must preserve the Caddy route ordering comment",
    )

    idx_weibo = caddy.find("handle /api/media/weibo {")
    idx_api = caddy.find("handle @api {")
    idx_catchall = caddy.find("handle /api/* {")
    idx_source = caddy.find("handle @source {")
    idx_spa = caddy.find("try_files {path} /index.html")
    require(
        0 < idx_weibo < idx_api < idx_catchall < idx_source < idx_spa,
        "ops/examples/snap.caddy handle blocks must order /api/media/weibo -> @api -> /api/* 404 -> @source -> SPA",
    )

    catchall_block = caddy[idx_catchall:idx_source]
    expected_404_json = (
        '{"schema_version":"1.0","code":"INVALID_INPUT",'
        '"error":{"code":"INVALID_INPUT","message":"接口不存在"}}'
    )
    require(
        'header Content-Type "application/json; charset=utf-8"' in catchall_block
        and 'header Cache-Control "no-store"' in catchall_block
        and f"respond `{expected_404_json}` 404" in catchall_block,
        "ops/examples/snap.caddy catch-all 'handle /api/*' must return 404 unified-v1 JSON with no-store header",
    )

    require(DEPLOYMENT_DOC_PATH.is_file(), f"Missing deployment doc: {DEPLOYMENT_DOC_PATH}")
    deploy_text = DEPLOYMENT_DOC_PATH.read_text(encoding="utf-8")
    require(
        "Caddy" in deploy_text and "白名单" in deploy_text,
        "docs/DEPLOYMENT.md must document updating the Caddy @api whitelist when adding new API paths",
    )
    return len(api_paths)


def check_batch_downloader_behavior() -> dict:
    prev_dont_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("agent_batch_download_testmod", str(BATCH_EXAMPLE_PATH))
        require(spec is not None and spec.loader is not None, "Failed to load examples/agent_batch_download.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = prev_dont_write

    douyin_meta = {"width": 1080, "height": 1920, "has_audio": True, "evidence": "upstream"}
    douyin_vod_url = "https://v26-web.douyinvod.com/abc/68eb15d2/video/tos/cn/tos-cn-ve-15/oXYZ/?a=6383&mime_type=video_mp4"

    mp4_head = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + (b"\x00" * 136)
    m4a_head = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A mp42" + (b"\x00" * 40)
    mov_head = b"\x00\x00\x00\x14ftypqt  \x20\x05\x03\x00qt  " + (b"\x00" * 40)
    jpg_head = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + (b"\xab" * 44)
    png_head = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + (b"\x00" * 48)
    webp_head = b"RIFF\x34\x00\x00\x00WEBPVP8 \x28\x00\x00\x00" + (b"\x00" * 40)
    gif87_head = b"GIF87a\x01\x00\x01\x00\x80\x00\x00" + (b"\x00" * 51)
    gif89_head = b"GIF89a\x01\x00\x01\x00\x80\x00\x00" + (b"\x00" * 51)
    unknown_head = b"\x00\x01\x02\x03opaque-unrecognized-payload-bytes" + (b"\xfe" * 32)

    # Tier 1: Parse/resolve result fields win over generic or conflicting Content-Type and magic bytes
    require(
        mod.infer_extension({"extension": "mov"}, douyin_vod_url, "application/octet-stream", jpg_head) == "mov",
        "Tier 1 metadata.extension must win over generic Content-Type and magic bytes",
    )
    require(
        mod.infer_extension({"extension": "jpeg"}, douyin_vod_url, "application/octet-stream", b"") == "jpg",
        "Tier 1 metadata.extension='jpeg' must normalize to 'jpg'",
    )
    require(
        mod.infer_extension({"mime_type": "video/webm; codecs=vp9"}, douyin_vod_url, "application/octet-stream") == "webm",
        "Tier 1 metadata.mime_type must win over generic Content-Type",
    )
    require(
        mod.infer_extension({"container": "quicktime"}, douyin_vod_url, "application/octet-stream") == "mov",
        "Tier 1 metadata.container='quicktime' must map to 'mov'",
    )
    require(
        mod.infer_extension({}, "https://pbs.twimg.com/media/example.jpeg?name=orig", "application/octet-stream") == "jpg",
        "Tier 1 known URL media suffix must win over generic Content-Type",
    )
    require(
        mod.infer_extension_from_result(douyin_meta, douyin_vod_url) is None
        and mod.infer_extension_from_result({}, "https://cdn.example.test/download.php?id=1") is None,
        "Extensionless douyinvod URL and non-media .php URL must return None in Tier 1",
    )

    # Tier 2: Download HTTP response Content-Type header
    for ctype, expected_ext in [
        ("video/mp4", "mp4"),
        ("video/mp4; charset=binary", "mp4"),
        ("video/webm", "webm"),
        ("video/quicktime", "mov"),
        ("audio/mp4", "m4a"),
        ("audio/x-m4a", "m4a"),
        ("audio/mpeg", "mp3"),
        ("image/jpeg", "jpg"),
        ("image/png", "png"),
        ("image/webp", "webp"),
        ("image/gif", "gif"),
        ("image/avif", "avif"),
    ]:
        got = mod.infer_extension(douyin_meta, douyin_vod_url, ctype, unknown_head)
        require(got == expected_ext, f"Tier 2 Content-Type {ctype!r} expected {expected_ext!r}, got {got!r}")

    # Tier 3: Leading file magic bytes when Content-Type is generic or non-media
    for generic_ct in ("application/octet-stream", "binary/octet-stream", "text/plain", "text/html", ""):
        require(mod.infer_extension(douyin_meta, douyin_vod_url, generic_ct, mp4_head) == "mp4", "Tier 3 ftyp -> mp4 failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", m4a_head) == "m4a", "Tier 3 ftyp M4A -> m4a failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", mov_head) == "mov", "Tier 3 ftyp qt -> mov failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", jpg_head) == "jpg", "Tier 3 JPEG -> jpg failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", png_head) == "png", "Tier 3 PNG -> png failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", webp_head) == "webp", "Tier 3 WebP -> webp failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", gif87_head) == "gif", "Tier 3 GIF87a -> gif failed")
    require(mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", gif89_head) == "gif", "Tier 3 GIF89a -> gif failed")

    # Tier 4: Fallback to .bin last
    require(
        mod.infer_extension(douyin_meta, douyin_vod_url, "application/octet-stream", unknown_head) == "bin",
        "Tier 4 unknown bytes + generic Content-Type must fall back to 'bin'",
    )

    # End-to-end loopback mock server test covering all 4 priority tiers + 206 Range resume + manifest idempotency
    test_token = "t" * 64
    cdn_blobs: dict[str, tuple[str, bytes]] = {
        "/cdn/tier1-result-field": ("application/octet-stream", unknown_head),
        "/video/tos/cn/tos-cn-ve-15/oDouyinCT/": ("video/mp4", mp4_head),
        "/video/tos/cn/tos-cn-ve-15/oDouyinFtyp/": ("application/octet-stream", mp4_head),
        "/cdn/magic-jpg": ("application/octet-stream", jpg_head),
        "/cdn/magic-png": ("application/octet-stream", png_head),
        "/cdn/magic-webp": ("application/octet-stream", webp_head),
        "/cdn/magic-gif": ("application/octet-stream", gif89_head),
        "/cdn/fallback-bin": ("application/octet-stream", unknown_head),
        "/video/tos/cn/tos-cn-ve-15/oDouyinResume/": ("application/octet-stream", mp4_head),
    }
    observed_cdn_ranges: list[tuple[str, str | None]] = []
    leaked_cdn_creds: list[str] = []

    class MockHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            pass

        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlsplit(self.path)
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if parsed.path == "/api/parse":
                if self.headers.get("Authorization") != f"Bearer {test_token}":
                    body = json.dumps({
                        "schema_version": "1.0",
                        "code": "INVALID_INPUT",
                        "error": {"code": "INVALID_INPUT", "message": "unauthorized", "retryable": False},
                    }).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                qs = urllib.parse.parse_qs(parsed.query)
                share_url = (qs.get("url") or [""])[0]
                case_map = {
                    "https://x.example.test/status/1": (
                        "x", "cid1", "video-1", {"extension": "mov"}, f"{origin}/cdn/tier1-result-field", len(unknown_head)
                    ),
                    "https://www.douyin.com/video/2": (
                        "douyin", "cid2", "video-1", douyin_meta,
                        f"{origin}/video/tos/cn/tos-cn-ve-15/oDouyinCT/?a=6383&mime_type=video_mp4", len(mp4_head),
                    ),
                    "https://www.douyin.com/video/3": (
                        "douyin", "cid3", "video-1", douyin_meta,
                        f"{origin}/video/tos/cn/tos-cn-ve-15/oDouyinFtyp/?a=6383", len(mp4_head),
                    ),
                    "https://www.douyin.com/note/4": (
                        "douyin", "cid4", "image-1", {"width": 1080, "height": 1440},
                        f"{origin}/cdn/magic-jpg", len(jpg_head),
                    ),
                    "https://www.douyin.com/note/5": (
                        "douyin", "cid5", "image-1", {"width": 1080, "height": 1440},
                        f"{origin}/cdn/magic-png", len(png_head),
                    ),
                    "https://www.douyin.com/note/6": (
                        "douyin", "cid6", "image-1", {"width": 1080, "height": 1440},
                        f"{origin}/cdn/magic-webp", len(webp_head),
                    ),
                    "https://www.douyin.com/note/7": (
                        "douyin", "cid7", "image-1", {"width": 480, "height": 480},
                        f"{origin}/cdn/magic-gif", len(gif89_head),
                    ),
                    "https://www.douyin.com/video/8": (
                        "douyin", "cid8", "video-1", douyin_meta,
                        f"{origin}/cdn/fallback-bin", len(unknown_head),
                    ),
                    "https://www.douyin.com/video/9": (
                        "douyin", "cid9", "video-1", douyin_meta,
                        f"{origin}/video/tos/cn/tos-cn-ve-15/oDouyinResume/?a=6383", len(mp4_head),
                    ),
                }
                plat, cid, iid, meta, cdn_url, sz = case_map[share_url]
                payload = json.dumps({
                    "schema_version": "1.0",
                    "code": "OK",
                    "data": {
                        "platform": plat,
                        "content_id": cid,
                        "source_url": share_url,
                        "items": [{
                            "id": iid,
                            "type": "video" if iid.startswith("video") else "image",
                            "state": "ready",
                            "index": 1,
                            "variants": [{
                                "id": "v-main",
                                "metadata": meta,
                                "delivery": {
                                    "kind": "file",
                                    "sources": [{"id": "s-1", "url": cdn_url, "access": "direct", "size_bytes": sz}],
                                },
                            }],
                            "default": {"variant_id": "v-main", "source_id": "s-1", "url": cdn_url, "access": "direct"},
                        }],
                    },
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if parsed.path in cdn_blobs:
                if self.headers.get("Authorization") or self.headers.get("Cookie"):
                    leaked_cdn_creds.append(parsed.path)
                ctype, full_data = cdn_blobs[parsed.path]
                range_hdr = self.headers.get("Range")
                observed_cdn_ranges.append((parsed.path, range_hdr))
                if range_hdr and range_hdr.startswith("bytes="):
                    start_str = range_hdr[len("bytes="):].split("-")[0]
                    start = int(start_str)
                    chunk = full_data[start:]
                    self.send_response(206)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Range", f"bytes {start}-{len(full_data) - 1}/{len(full_data)}")
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                    return

                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(full_data)))
                self.end_headers()
                self.wfile.write(full_data)
                return

            self.send_response(404)
            self.end_headers()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    prev_token = os.environ.get("DOKITOOL_OWNER_TOKEN")
    os.environ["DOKITOOL_OWNER_TOKEN"] = test_token

    try:
        with tempfile.TemporaryDirectory(prefix="dokitool-batch-e2e-") as tmp:
            tmp_dir = Path(tmp)
            out_dir = tmp_dir / "downloads"
            out_dir.mkdir(parents=True, exist_ok=True)
            urls_file = tmp_dir / "urls.txt"
            share_inputs = [
                "https://x.example.test/status/1",
                "https://www.douyin.com/video/2",
                "https://www.douyin.com/video/3",
                "https://www.douyin.com/note/4",
                "https://www.douyin.com/note/5",
                "https://www.douyin.com/note/6",
                "https://www.douyin.com/note/7",
                "https://www.douyin.com/video/8",
                "https://www.douyin.com/video/9",
            ]
            urls_file.write_text("\n".join(share_inputs) + "\n", encoding="utf-8")

            # Pre-seed interrupted .part file (first 64 bytes of mp4_head) for case #9
            resume_part = out_dir / "douyin_cid9_video-1.part"
            resume_part.write_bytes(mp4_head[:64])

            api_base = f"http://127.0.0.1:{server.server_port}"
            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                rc1 = mod.main([
                    "--api-base", api_base,
                    "--input", str(urls_file),
                    "--output-dir", str(out_dir),
                    "--concurrency", "2",
                ])
            require(rc1 == 0, f"Batch downloader first run failed (rc={rc1}): {stderr_buf.getvalue()}")
            run1_summary = json.loads(stdout_buf.getvalue().strip())
            require(run1_summary["ok"] == 9 and run1_summary["failed"] == 0, f"Unexpected run1 summary: {run1_summary}")
            require(not leaked_cdn_creds, f"Credentials leaked to CDN paths: {leaked_cdn_creds}")
            require(
                ("/video/tos/cn/tos-cn-ve-15/oDouyinResume/", "bytes=64-") in observed_cdn_ranges,
                f"Expected Range: bytes=64- on resumed extensionless MP4, got {observed_cdn_ranges}",
            )
            require(not resume_part.exists(), "Resumed .part file must be atomically replaced")

            expected_files = {
                "x_cid1_video-1.mov": unknown_head,
                "douyin_cid2_video-1.mp4": mp4_head,
                "douyin_cid3_video-1.mp4": mp4_head,
                "douyin_cid4_image-1.jpg": jpg_head,
                "douyin_cid5_image-1.png": png_head,
                "douyin_cid6_image-1.webp": webp_head,
                "douyin_cid7_image-1.gif": gif89_head,
                "douyin_cid8_video-1.bin": unknown_head,
                "douyin_cid9_video-1.mp4": mp4_head,
            }
            for fname, expected_bytes in expected_files.items():
                fpath = out_dir / fname
                require(fpath.is_file(), f"Expected output file missing: {fname}")
                require(fpath.read_bytes() == expected_bytes, f"Byte mismatch in downloaded file: {fname}")

            manifest_records = [
                json.loads(line)
                for line in (out_dir / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            require(len(manifest_records) == 9, f"Expected 9 manifest records, got {len(manifest_records)}")
            manifest_files = {rec["files"][0]["file"] for rec in manifest_records}
            require(manifest_files == set(expected_files.keys()), f"Manifest filenames mismatch: {manifest_files}")

            # Second run must skip all 9 completed inputs via manifest.jsonl without hitting CDN again
            cdn_calls_before_run2 = len(observed_cdn_ranges)
            stdout_buf2 = io.StringIO()
            stderr_buf2 = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf2), contextlib.redirect_stderr(stderr_buf2):
                rc2 = mod.main([
                    "--api-base", api_base,
                    "--input", str(urls_file),
                    "--output-dir", str(out_dir),
                    "--concurrency", "2",
                ])
            require(rc2 == 0, f"Batch downloader idempotent rerun failed (rc={rc2})")
            run2_summary = json.loads(stdout_buf2.getvalue().strip())
            require(
                run2_summary == {"total": 9, "skipped_completed": 9, "processed": 0}
                and len(observed_cdn_ranges) == cdn_calls_before_run2,
                f"Expected zero reprocessing on second run, got {run2_summary}",
            )
    finally:
        if prev_token is None:
            os.environ.pop("DOKITOOL_OWNER_TOKEN", None)
        else:
            os.environ["DOKITOOL_OWNER_TOKEN"] = prev_token
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5.0)

    return {"unit_priority_tiers": 4, "e2e_cases": 9, "range_resume_verified": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-jsonschema",
        action="store_true",
        help="Fail if the jsonschema Draft 2020-12 validator package is not installed",
    )
    args = parser.parse_args(argv)

    spec = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
    unified_schema = json.loads(UNIFIED_SCHEMA_PATH.read_text(encoding="utf-8"))
    platforms_cfg = json.loads(PLATFORMS_PATH.read_text(encoding="utf-8"))

    ref_count = check_openapi_structure(spec, unified_schema, platforms_cfg)
    doc_blocks = len(extract_markdown_json_blocks(AGENT_API_DOC_PATH))
    js_report = check_with_jsonschema(spec, require_installed=args.require_jsonschema)
    check_python_scripts()
    caddy_paths = check_caddy_whitelist()
    batch_report = check_batch_downloader_behavior()

    summary = {
        "openapi": spec["openapi"],
        "paths": sorted(spec["paths"].keys()),
        "schemas": len(spec["components"]["schemas"]),
        "resolved_refs": ref_count,
        "agent_api_json_examples": doc_blocks,
        "jsonschema_draft2020_12": js_report,
        "caddy_whitelisted_paths": caddy_paths,
        "example_script_compiled": True,
        "batch_downloader_tests": batch_report,
        "passed": True,
    }
    print(json.dumps(summary, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
