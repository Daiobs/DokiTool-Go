#!/usr/bin/env python3
"""Offline validator for docs/openapi.json, ops/examples/{snap.caddy,api-keys.example.json}, and examples/agent_batch_download.py.

Performs zero external network requests. Verifies:
1. OpenAPI 3.1.0 top-level metadata, paths, parameters, status codes, headers, and BearerAuth security;
2. Every internal $ref resolves cleanly with zero external/network $refs;
3. Exact structural & enum parity between docs/openapi.json and docs/schema/unified-v1/unified-v1.schema.json,
   backend/config/platforms.json, and the GET /api/stats StatsSnapshot & APIKeyStatsSnapshot contracts;
4. Draft 2020-12 JSON Schema validity and fixture conformance (via jsonschema when installed,
   required when --require-jsonschema is passed in CI);
5. Caddy example per-path @api whitelist parity and 404 JSON catch-all ordering in ops/examples/snap.caddy,
   plus schema/role/digest/platform-scope validity of ops/examples/api-keys.example.json;
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
API_KEYS_EXAMPLE_PATH = ROOT / "ops/examples/api-keys.example.json"
RUNTIME_CONFIG_EXAMPLE_PATH = ROOT / "ops/examples/runtime.example.json"
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
EXPECTED_API_KEY_ROLES = ["owner", "agent", "friend"]
EXPECTED_API_KEY_STATS_REQUIRED = [
    "id",
    "role",
    "enabled",
    "active",
    "slow_active",
    "queued",
    "concurrency_limit",
    "slow_concurrency_limit",
    "queue_limit",
    "requests_total",
    "ok",
    "errors",
    "cache_hits",
    "rate_limited",
    "unauthorized",
    "waited",
    "granted",
    "timeout",
    "full",
    "canceled",
    "wait_ms_total",
    "wait_ms_max",
]
EXPECTED_STATS_PLATFORM_PATTERN = "^[a-z0-9][a-z0-9_:-]{0,31}$"
EXPECTED_RUNTIME_CONFIG_REQUIRED = [
    "version",
    "shanghai_mode",
    "shanghai_bilibili",
    "bilibili_dash",
    "youtube_helper",
    "xhs_transport",
    "ytdlp_enabled",
    "ytdlp_generic_enabled",
    "tbvideo_pipigx",
    "tbvideo_zuiyou",
    "stats_persistence_enabled",
]
EXPECTED_DAILY_LATENCY_REQUIRED = ["p50_ms", "p95_ms", "max_ms"]
EXPECTED_DAILY_PLATFORM_REQUIRED = ["total", "ok", "failed", "by_code", "p95_ms"]
EXPECTED_DAILY_BUCKET_REQUIRED = [
    "date",
    "total",
    "ok",
    "failed",
    "cache_hits",
    "shanghai_hits",
    "latency_ms",
    "by_platform",
]
EXPECTED_HOURLY_BUCKET_REQUIRED = ["hour_start", "total", "ok", "failed", "cache_hits"]
EXPECTED_CACHE_CHANNEL_COUNTS_REQUIRED = ["hits", "stale_hits", "misses", "singleflight_shared", "uncacheable"]
EXPECTED_YTDLP_COMPARTMENT_REQUIRED = [
    "enabled",
    "active",
    "queued",
    "concurrency_limit",
    "queue_limit",
    "waited",
    "granted",
    "timeout",
    "full",
    "canceled",
    "wait_ms_total",
    "wait_ms_max",
]
EXPECTED_YTDLP_POOLS_REQUIRED = ["youtube", "social", "generic", "youtube_ejs"]
EXPECTED_CIRCUIT_BREAKER_STATES = ["closed", "open", "half_open"]
EXPECTED_CIRCUIT_BREAKER_REQUIRED = [
    "platform",
    "state",
    "consecutive_failures",
    "window_failures",
    "window_total",
    "open_until",
    "disabled_by_config",
]
EXPECTED_RUNTIME_POLICY_REQUIRED = [
    "config_file_active",
    "reload_count",
    "last_reloaded_at",
    "youtube_slots",
    "social_slots",
    "generic_slots",
    "youtube_ejs_concurrency",
    "fast_per_platform_max_concurrency",
    "circuit_breaker_enabled",
    "disabled_platforms",
    "youtube_parse_ttl_seconds",
    "stale_if_error_ttl_seconds",
    "upstream_blocked_neg_ttl_seconds",
]
EMPTY_STRING_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


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

    attachment_schema = comp_schemas.get("Attachment") or {}
    attachment_props = attachment_schema.get("properties") or {}
    track_kind_schema = attachment_props.get("track_kind") or {}
    require(
        attachment_schema.get("additionalProperties") is False
        and track_kind_schema.get("type") == "string"
        and track_kind_schema.get("enum") == ["manual", "auto"],
        "Attachment.properties.track_kind must be string enum ['manual', 'auto'] with additionalProperties=false",
    )

    # Parity check with backend/config/platforms.json + 5 optional Go-registered platforms
    optional_go_platforms = ["x", "youtube", "instagram", "facebook", "tumblr"]
    platform_ids = [entry["id"] for entry in platforms_cfg] + optional_go_platforms
    require(len(set(platform_ids)) == 14, "Expected 14 distinct platform IDs across platforms.json + Go adapters")
    require(
        comp_schemas["PlatformQuery"]["enum"] == ["all", *platform_ids],
        "PlatformQuery enum does not match the 14 registered platform IDs",
    )
    all_cfg_caps = {cap for entry in platforms_cfg for cap in entry.get("capabilities", [])}
    require(
        all_cfg_caps <= set(comp_schemas["PlatformCapability"]["enum"]),
        "PlatformCapability enum is missing capability values from backend/config/platforms.json",
    )
    stats_platform = comp_schemas.get("StatsPlatform") or {}
    require(
        stats_platform.get("type") == "string"
        and "enum" not in stats_platform
        and stats_platform.get("pattern") == EXPECTED_STATS_PLATFORM_PATTERN
        and stats_platform.get("maxLength") == 32,
        "StatsPlatform must be a bounded pattern string (^[a-z0-9][a-z0-9_:-]{0,31}$, maxLength=32)",
    )
    stats_platform_re = re.compile(EXPECTED_STATS_PLATFORM_PATTERN)
    for pid in [*platform_ids, "unknown", "ytdlp_other"]:
        require(
            bool(stats_platform_re.fullmatch(pid)),
            f"StatsPlatform pattern must accept platform id {pid!r}",
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
        comp_schemas["ShanghaiPlatformBreakdown"]["required"] == ["douyin", "bilibili"]
        and "by_platform" in comp_schemas["ShanghaiStatsSnapshot"]["required"],
        "ShanghaiStatsSnapshot must require by_platform.{douyin,bilibili}",
    )
    require(
        comp_schemas["APIKeyRole"]["enum"] == EXPECTED_API_KEY_ROLES,
        "APIKeyRole enum must equal ['owner', 'agent', 'friend']",
    )
    api_key_snap = comp_schemas.get("APIKeyStatsSnapshot") or {}
    api_key_props = api_key_snap.get("properties") or {}
    require(
        api_key_snap.get("additionalProperties") is False
        and len(EXPECTED_API_KEY_STATS_REQUIRED) == 22
        and api_key_snap.get("required") == EXPECTED_API_KEY_STATS_REQUIRED
        and list(api_key_props.keys()) == EXPECTED_API_KEY_STATS_REQUIRED,
        "APIKeyStatsSnapshot must require the exact 22 fields with additionalProperties=false",
    )
    require(
        api_key_props["id"].get("type") == "string"
        and api_key_props["id"].get("pattern") == "^[a-z0-9][a-z0-9_-]{0,31}$"
        and api_key_props["role"].get("$ref") == "#/components/schemas/APIKeyRole"
        and api_key_props["enabled"].get("type") == "boolean",
        "APIKeyStatsSnapshot id/role/enabled schema mismatch",
    )
    for int_field in EXPECTED_API_KEY_STATS_REQUIRED[3:]:
        require(
            api_key_props[int_field].get("type") == "integer"
            and api_key_props[int_field].get("minimum") == 0,
            f"APIKeyStatsSnapshot.{int_field} must be integer with minimum=0",
        )
    runtime_snap = comp_schemas.get("RuntimeConfigSnapshot") or {}
    runtime_props = runtime_snap.get("properties") or {}
    require(
        runtime_snap.get("additionalProperties") is False
        and runtime_snap.get("required") == EXPECTED_RUNTIME_CONFIG_REQUIRED
        and list(runtime_props.keys()) == EXPECTED_RUNTIME_CONFIG_REQUIRED,
        "RuntimeConfigSnapshot must require the exact 11 fields with additionalProperties=false",
    )
    require(
        runtime_props["version"].get("type") == "string"
        and runtime_props["shanghai_mode"].get("enum") == ["off", "direct", "pull"]
        and runtime_props["xhs_transport"].get("enum") == ["standard", "chrome131"],
        "RuntimeConfigSnapshot version/shanghai_mode/xhs_transport schema mismatch",
    )
    for bool_field in EXPECTED_RUNTIME_CONFIG_REQUIRED:
        if bool_field not in {"version", "shanghai_mode", "xhs_transport"}:
            require(
                runtime_props[bool_field].get("type") == "boolean",
                f"RuntimeConfigSnapshot.{bool_field} must be boolean",
            )

    daily_lat = comp_schemas.get("DailyLatencySummary") or {}
    daily_lat_props = daily_lat.get("properties") or {}
    require(
        daily_lat.get("additionalProperties") is False
        and daily_lat.get("required") == EXPECTED_DAILY_LATENCY_REQUIRED
        and list(daily_lat_props.keys()) == EXPECTED_DAILY_LATENCY_REQUIRED,
        "DailyLatencySummary must require p50_ms, p95_ms, max_ms with additionalProperties=false",
    )
    for int_field in EXPECTED_DAILY_LATENCY_REQUIRED:
        require(
            daily_lat_props[int_field].get("type") == "integer"
            and daily_lat_props[int_field].get("minimum") == 0,
            f"DailyLatencySummary.{int_field} must be integer with minimum=0",
        )

    daily_plat = comp_schemas.get("DailyPlatformStats") or {}
    daily_plat_props = daily_plat.get("properties") or {}
    require(
        daily_plat.get("additionalProperties") is False
        and daily_plat.get("required") == EXPECTED_DAILY_PLATFORM_REQUIRED
        and list(daily_plat_props.keys()) == EXPECTED_DAILY_PLATFORM_REQUIRED,
        "DailyPlatformStats must require total, ok, failed, by_code, p95_ms with additionalProperties=false",
    )
    for int_field in ("total", "ok", "failed", "p95_ms"):
        require(
            daily_plat_props[int_field].get("type") == "integer"
            and daily_plat_props[int_field].get("minimum") == 0,
            f"DailyPlatformStats.{int_field} must be integer with minimum=0",
        )
    require(
        daily_plat_props["by_code"].get("type") == "object"
        and daily_plat_props["by_code"].get("additionalProperties") == {"type": "integer", "minimum": 0},
        "DailyPlatformStats.by_code must map strings to non-negative integers",
    )

    daily_bucket = comp_schemas.get("DailyStatsBucket") or {}
    daily_bucket_props = daily_bucket.get("properties") or {}
    require(
        daily_bucket.get("additionalProperties") is False
        and daily_bucket.get("required") == EXPECTED_DAILY_BUCKET_REQUIRED
        and list(daily_bucket_props.keys()) == EXPECTED_DAILY_BUCKET_REQUIRED,
        "DailyStatsBucket must require the exact 8 fields with additionalProperties=false",
    )
    require(
        daily_bucket_props["date"].get("type") == "string"
        and daily_bucket_props["date"].get("pattern") == r"^\d{4}-\d{2}-\d{2}$"
        and daily_bucket_props["latency_ms"].get("$ref") == "#/components/schemas/DailyLatencySummary"
        and daily_bucket_props["by_platform"].get("type") == "object"
        and daily_bucket_props["by_platform"].get("additionalProperties")
        == {"$ref": "#/components/schemas/DailyPlatformStats"},
        "DailyStatsBucket date/latency_ms/by_platform schema mismatch",
    )
    for int_field in ("total", "ok", "failed", "cache_hits", "shanghai_hits"):
        require(
            daily_bucket_props[int_field].get("type") == "integer"
            and daily_bucket_props[int_field].get("minimum") == 0,
            f"DailyStatsBucket.{int_field} must be integer with minimum=0",
        )

    hourly_bucket = comp_schemas.get("HourlyStatsBucket") or {}
    hourly_bucket_props = hourly_bucket.get("properties") or {}
    require(
        hourly_bucket.get("additionalProperties") is False
        and hourly_bucket.get("required") == EXPECTED_HOURLY_BUCKET_REQUIRED
        and list(hourly_bucket_props.keys()) == EXPECTED_HOURLY_BUCKET_REQUIRED,
        "HourlyStatsBucket must require the exact 5 fields with additionalProperties=false",
    )
    require(
        hourly_bucket_props["hour_start"].get("type") == "string"
        and hourly_bucket_props["hour_start"].get("format") == "date-time",
        "HourlyStatsBucket.hour_start must be a date-time string",
    )
    for int_field in ("total", "ok", "failed", "cache_hits"):
        require(
            hourly_bucket_props[int_field].get("type") == "integer"
            and hourly_bucket_props[int_field].get("minimum") == 0,
            f"HourlyStatsBucket.{int_field} must be integer with minimum=0",
        )

    cache_counts = comp_schemas.get("CacheChannelCounts") or {}
    cache_counts_props = cache_counts.get("properties") or {}
    require(
        cache_counts.get("additionalProperties") is False
        and cache_counts.get("required") == EXPECTED_CACHE_CHANNEL_COUNTS_REQUIRED
        and list(cache_counts_props.keys()) == EXPECTED_CACHE_CHANNEL_COUNTS_REQUIRED,
        "CacheChannelCounts must require hits, stale_hits, misses, singleflight_shared, uncacheable with additionalProperties=false",
    )
    for int_field in EXPECTED_CACHE_CHANNEL_COUNTS_REQUIRED:
        require(
            cache_counts_props[int_field].get("type") == "integer"
            and cache_counts_props[int_field].get("minimum") == 0,
            f"CacheChannelCounts.{int_field} must be integer with minimum=0",
        )

    yt_comp = comp_schemas.get("YTDLPCompartmentPoolSnapshot") or {}
    yt_comp_props = yt_comp.get("properties") or {}
    require(
        yt_comp.get("additionalProperties") is False
        and yt_comp.get("required") == EXPECTED_YTDLP_COMPARTMENT_REQUIRED
        and list(yt_comp_props.keys()) == EXPECTED_YTDLP_COMPARTMENT_REQUIRED,
        "YTDLPCompartmentPoolSnapshot must require exact 12 fields with additionalProperties=false",
    )
    require(yt_comp_props["enabled"].get("type") == "boolean", "YTDLPCompartmentPoolSnapshot.enabled must be boolean")
    for int_field in EXPECTED_YTDLP_COMPARTMENT_REQUIRED[1:]:
        require(
            yt_comp_props[int_field].get("type") == "integer"
            and yt_comp_props[int_field].get("minimum") == 0,
            f"YTDLPCompartmentPoolSnapshot.{int_field} must be integer with minimum=0",
        )

    yt_pools = comp_schemas.get("YTDLPPoolsSnapshot") or {}
    yt_pools_props = yt_pools.get("properties") or {}
    require(
        yt_pools.get("additionalProperties") is False
        and yt_pools.get("required") == EXPECTED_YTDLP_POOLS_REQUIRED
        and list(yt_pools_props.keys()) == EXPECTED_YTDLP_POOLS_REQUIRED,
        "YTDLPPoolsSnapshot must require youtube, social, generic, youtube_ejs with additionalProperties=false",
    )
    for comp_key in EXPECTED_YTDLP_POOLS_REQUIRED:
        require(
            yt_pools_props[comp_key].get("$ref") == "#/components/schemas/YTDLPCompartmentPoolSnapshot",
            f"YTDLPPoolsSnapshot.{comp_key} must reference YTDLPCompartmentPoolSnapshot",
        )

    require(
        (comp_schemas.get("CircuitBreakerState") or {}).get("enum") == EXPECTED_CIRCUIT_BREAKER_STATES,
        "CircuitBreakerState enum must equal ['closed', 'open', 'half_open']",
    )
    cb_snap = comp_schemas.get("CircuitBreakerPlatformSnapshot") or {}
    cb_props = cb_snap.get("properties") or {}
    require(
        cb_snap.get("additionalProperties") is False
        and cb_snap.get("required") == EXPECTED_CIRCUIT_BREAKER_REQUIRED
        and list(cb_props.keys()) == EXPECTED_CIRCUIT_BREAKER_REQUIRED,
        "CircuitBreakerPlatformSnapshot must require exact 7 fields with additionalProperties=false",
    )
    require(
        set(cb_props["platform"].get("enum") or []) == set(platform_ids)
        and len(cb_props["platform"].get("enum") or []) == 14
        and cb_props["state"].get("$ref") == "#/components/schemas/CircuitBreakerState"
        and cb_props["disabled_by_config"].get("type") == "boolean",
        "CircuitBreakerPlatformSnapshot platform/state/disabled_by_config schema mismatch",
    )
    for int_field in ("consecutive_failures", "window_failures", "window_total"):
        require(
            cb_props[int_field].get("type") == "integer"
            and cb_props[int_field].get("minimum") == 0,
            f"CircuitBreakerPlatformSnapshot.{int_field} must be integer with minimum=0",
        )

    gcb_snap = comp_schemas.get("GenericCircuitBreakerSnapshot") or {}
    gcb_props = gcb_snap.get("properties") or {}
    require(
        gcb_snap.get("additionalProperties") is False
        and gcb_snap.get("required") == EXPECTED_CIRCUIT_BREAKER_REQUIRED
        and list(gcb_props.keys()) == EXPECTED_CIRCUIT_BREAKER_REQUIRED,
        "GenericCircuitBreakerSnapshot must require exact 7 fields with additionalProperties=false",
    )
    require(
        gcb_props["platform"].get("enum") == ["ytdlp_generic"]
        and gcb_props["state"].get("$ref") == "#/components/schemas/CircuitBreakerState"
        and gcb_props["disabled_by_config"].get("type") == "boolean",
        "GenericCircuitBreakerSnapshot platform/state/disabled_by_config schema mismatch",
    )
    for int_field in ("consecutive_failures", "window_failures", "window_total"):
        require(
            gcb_props[int_field].get("type") == "integer"
            and gcb_props[int_field].get("minimum") == 0,
            f"GenericCircuitBreakerSnapshot.{int_field} must be integer with minimum=0",
        )

    rp_snap = comp_schemas.get("RuntimePolicySummary") or {}
    rp_props = rp_snap.get("properties") or {}
    require(
        rp_snap.get("additionalProperties") is False
        and rp_snap.get("required") == EXPECTED_RUNTIME_POLICY_REQUIRED
        and list(rp_props.keys()) == EXPECTED_RUNTIME_POLICY_REQUIRED,
        "RuntimePolicySummary must require exact 13 fields with additionalProperties=false",
    )
    require(
        rp_props["config_file_active"].get("type") == "boolean"
        and rp_props["circuit_breaker_enabled"].get("type") == "boolean"
        and rp_props["disabled_platforms"].get("type") == "array"
        and (rp_props["disabled_platforms"].get("items") or {}).get("$ref") == "#/components/schemas/RuntimePolicyPlatform"
        and set((comp_schemas.get("RuntimePolicyPlatform") or {}).get("enum") or []) == (set(platform_ids) | {"ytdlp_generic"}),
        "RuntimePolicySummary boolean/disabled_platforms schema mismatch",
    )

    adm_snap = comp_schemas.get("AdmissionStatsSnapshot") or {}
    adm_props = adm_snap.get("properties") or {}
    require(
        adm_snap.get("additionalProperties") is False
        and adm_snap.get("required") == ["fast", "slow", "generic_slow", "owner"]
        and list(adm_props.keys()) == ["fast", "slow", "generic_slow", "owner"],
        "AdmissionStatsSnapshot must require fast, slow, generic_slow, owner with additionalProperties=false",
    )
    for pool_key in ("fast", "slow", "generic_slow", "owner"):
        require(
            adm_props[pool_key].get("$ref") == "#/components/schemas/AdmissionPoolSnapshot",
            f"AdmissionStatsSnapshot.{pool_key} must reference AdmissionPoolSnapshot",
        )

    require(
        comp_schemas["StatsSnapshot"]["required"] == [
            "started_at", "generated_at", "uptime_seconds",
            "requests", "cache", "admission", "ytdlp", "ytdlp_generic",
            "ytdlp_pools", "circuit_breakers", "runtime_policy",
            "shanghai", "parse_latency_ms", "api_keys",
            "runtime", "daily", "hourly",
        ],
        "StatsSnapshot required fields mismatch",
    )
    ytdlp_generic_prop = comp_schemas["StatsSnapshot"]["properties"].get("ytdlp_generic") or {}
    require(
        ytdlp_generic_prop.get("$ref") == "#/components/schemas/YTDLPStatsSnapshot",
        "StatsSnapshot.ytdlp_generic must reference YTDLPStatsSnapshot",
    )
    ytdlp_pools_prop = comp_schemas["StatsSnapshot"]["properties"].get("ytdlp_pools") or {}
    require(
        ytdlp_pools_prop.get("$ref") == "#/components/schemas/YTDLPPoolsSnapshot",
        "StatsSnapshot.ytdlp_pools must reference YTDLPPoolsSnapshot",
    )
    yt_helper_prop = comp_schemas["StatsSnapshot"]["properties"].get("youtube_helper") or {}
    require(
        yt_helper_prop.get("$ref") == "#/components/schemas/YouTubeHelperStatsSnapshot",
        "StatsSnapshot.youtube_helper must reference YouTubeHelperStatsSnapshot",
    )
    cb_list_prop = comp_schemas["StatsSnapshot"]["properties"].get("circuit_breakers") or {}
    require(
        cb_list_prop.get("type") == "array"
        and cb_list_prop.get("minItems") == 14
        and cb_list_prop.get("maxItems") == 14
        and (cb_list_prop.get("items") or {}).get("$ref") == "#/components/schemas/CircuitBreakerPlatformSnapshot",
        "StatsSnapshot.circuit_breakers must be fixed 14-item array of CircuitBreakerPlatformSnapshot",
    )
    gcb_prop = comp_schemas["StatsSnapshot"]["properties"].get("generic_circuit_breaker") or {}
    require(
        gcb_prop.get("$ref") == "#/components/schemas/GenericCircuitBreakerSnapshot",
        "StatsSnapshot.generic_circuit_breaker must reference GenericCircuitBreakerSnapshot",
    )
    rp_prop = comp_schemas["StatsSnapshot"]["properties"].get("runtime_policy") or {}
    require(
        rp_prop.get("$ref") == "#/components/schemas/RuntimePolicySummary",
        "StatsSnapshot.runtime_policy must reference RuntimePolicySummary",
    )
    api_keys_prop = comp_schemas["StatsSnapshot"]["properties"].get("api_keys") or {}
    require(
        api_keys_prop.get("type") == "array"
        and api_keys_prop.get("maxItems") == 64
        and (api_keys_prop.get("items") or {}).get("$ref") == "#/components/schemas/APIKeyStatsSnapshot",
        "StatsSnapshot.api_keys must be maxItems=64 array of APIKeyStatsSnapshot",
    )
    runtime_prop = comp_schemas["StatsSnapshot"]["properties"].get("runtime") or {}
    require(
        runtime_prop.get("$ref") == "#/components/schemas/RuntimeConfigSnapshot",
        "StatsSnapshot.runtime must reference RuntimeConfigSnapshot",
    )
    daily_prop = comp_schemas["StatsSnapshot"]["properties"].get("daily") or {}
    require(
        daily_prop.get("type") == "array"
        and daily_prop.get("minItems") == 0
        and daily_prop.get("maxItems") == 30
        and (daily_prop.get("items") or {}).get("$ref") == "#/components/schemas/DailyStatsBucket",
        "StatsSnapshot.daily must be minItems=0, maxItems=30 array of DailyStatsBucket",
    )
    hourly_prop = comp_schemas["StatsSnapshot"]["properties"].get("hourly") or {}
    require(
        hourly_prop.get("type") == "array"
        and hourly_prop.get("minItems") == 0
        and hourly_prop.get("maxItems") == 24
        and (hourly_prop.get("items") or {}).get("$ref") == "#/components/schemas/HourlyStatsBucket",
        "StatsSnapshot.hourly must be minItems=0, maxItems=24 array of HourlyStatsBucket",
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
    zero_cache_ch = {"hits": 0, "stale_hits": 0, "misses": 0, "singleflight_shared": 0, "uncacheable": 0}
    zero_pool = {
        "active": 0, "queued": 0, "concurrency_limit": 8, "queue_limit": 256,
        "waited": 0, "granted": 0, "timeout": 0, "full": 0, "canceled": 0,
        "wait_ms_total": 0, "wait_ms_max": 0,
    }
    zero_comp_pool = {"enabled": False, **zero_pool}
    sample_ytdlp_pools = {
        "youtube": {**zero_comp_pool, "enabled": True, "concurrency_limit": 4, "queue_limit": 32},
        "social": {**zero_comp_pool, "enabled": True, "concurrency_limit": 4, "queue_limit": 32},
        "generic": {**zero_comp_pool, "enabled": False, "concurrency_limit": 2, "queue_limit": 16},
        "youtube_ejs": {**zero_comp_pool, "enabled": True, "concurrency_limit": 6, "queue_limit": 64},
    }
    core_14_platforms = [
        "douyin", "bilibili", "weibo", "toutiao", "kuaishou", "pipixia", "pipigx",
        "zuiyou", "xiaohongshu", "x", "youtube", "instagram", "facebook", "tumblr",
    ]
    sample_circuit_breakers = [
        {
            "platform": p,
            "state": "closed",
            "consecutive_failures": 0,
            "window_failures": 0,
            "window_total": 0,
            "open_until": "",
            "disabled_by_config": False,
        }
        for p in core_14_platforms
    ]
    sample_runtime_policy = {
        "config_file_active": False,
        "reload_count": 0,
        "last_reloaded_at": "",
        "youtube_slots": 4,
        "social_slots": 4,
        "generic_slots": 2,
        "youtube_ejs_concurrency": 6,
        "fast_per_platform_max_concurrency": 24,
        "circuit_breaker_enabled": True,
        "disabled_platforms": [],
        "youtube_parse_ttl_seconds": 120,
        "stale_if_error_ttl_seconds": 600,
        "upstream_blocked_neg_ttl_seconds": 5,
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
    sample_api_key = {
        "id": "agent-bot",
        "role": "agent",
        "enabled": True,
        "active": 0,
        "slow_active": 0,
        "queued": 0,
        "concurrency_limit": 4,
        "slow_concurrency_limit": 1,
        "queue_limit": 128,
        "requests_total": 1,
        "ok": 1,
        "errors": 0,
        "cache_hits": 1,
        "rate_limited": 0,
        "unauthorized": 0,
        "waited": 0,
        "granted": 0,
        "timeout": 0,
        "full": 0,
        "canceled": 0,
        "wait_ms_total": 0,
        "wait_ms_max": 0,
    }
    sample_runtime = {
        "version": "1.0.0",
        "shanghai_mode": "pull",
        "shanghai_bilibili": True,
        "bilibili_dash": False,
        "youtube_helper": True,
        "xhs_transport": "chrome131",
        "ytdlp_enabled": True,
        "ytdlp_generic_enabled": False,
        "tbvideo_pipigx": False,
        "tbvideo_zuiyou": False,
        "stats_persistence_enabled": True,
    }
    sample_daily_bucket = {
        "date": "2026-11-15",
        "total": 2,
        "ok": 2,
        "failed": 0,
        "cache_hits": 1,
        "shanghai_hits": 1,
        "latency_ms": {"p50_ms": 100, "p95_ms": 250, "max_ms": 250},
        "by_platform": {
            "douyin": {
                "total": 1,
                "ok": 1,
                "failed": 0,
                "by_code": {"OK": 1},
                "p95_ms": 100,
            },
            "ytdlp_other": {
                "total": 1,
                "ok": 1,
                "failed": 0,
                "by_code": {"OK": 1},
                "p95_ms": 250,
            },
        },
    }
    sample_hourly_bucket = {
        "hour_start": "2026-11-15T08:00:00+08:00",
        "total": 2,
        "ok": 2,
        "failed": 0,
        "cache_hits": 1,
    }
    base_stats_data = {
        "started_at": "2026-11-15T00:00:00Z",
        "generated_at": "2026-11-15T00:05:00Z",
        "uptime_seconds": 300,
        "requests": {
            "total": 2,
            "by_channel": {"anonymous": 0, "owner": 2},
            "by_platform_code_channel": [
                {"platform": "douyin", "code": "OK", "channel": "owner", "count": 1},
                {"platform": "vimeo:embed", "code": "OK", "channel": "owner", "count": 1},
            ],
        },
        "cache": {
            "enabled": True, "entries": 1, "bytes": 512, "max_entries": 4096, "max_bytes": 67108864,
            "total": zero_cache_ch,
            "by_channel": {"anonymous": zero_cache_ch, "owner": zero_cache_ch},
        },
        "admission": {"fast": zero_pool, "slow": zero_pool, "generic_slow": zero_pool, "owner": zero_pool},
        "ytdlp": {
            "enabled": True, "active": 0, "waiting": 0, "concurrency_limit": 2,
            "total": zero_slot,
            "by_channel": {"anonymous": zero_slot, "owner": zero_slot},
        },
        "ytdlp_generic": {
            "enabled": False, "active": 0, "waiting": 0, "concurrency_limit": 0,
            "total": zero_slot,
            "by_channel": {"anonymous": zero_slot, "owner": zero_slot},
        },
        "ytdlp_pools": sample_ytdlp_pools,
        "circuit_breakers": sample_circuit_breakers,
        "runtime_policy": sample_runtime_policy,
        "shanghai": {
            "enabled": True, "mode": "pull", "waiting_workers": 3, "queued_tasks": 0, "pending_tasks": 0,
            "total": zero_sh,
            "by_channel": {"anonymous": zero_sh, "owner": zero_sh},
            "by_platform": {"douyin": zero_sh, "bilibili": zero_sh},
        },
        "parse_latency_ms": {
            "total": zero_hist,
            "by_channel": {"anonymous": zero_hist, "owner": zero_hist},
        },
        "api_keys": [sample_api_key],
        "runtime": sample_runtime,
        "daily": [sample_daily_bucket],
        "hourly": [sample_hourly_bucket],
    }
    require(not list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": base_stats_data,
    })), "Valid /api/stats payload with api_keys/runtime/daily/hourly rejected")
    require(not list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "api_keys": [], "daily": [], "hourly": []},
    })), "Valid /api/stats payload with empty api_keys/daily/hourly rejected")
    for req_field in ("ytdlp_generic", "ytdlp_pools", "circuit_breakers", "runtime_policy", "api_keys", "runtime", "daily", "hourly"):
        require(bool(list(stats_val.iter_errors({
            "schema_version": "1.0",
            "code": "OK",
            "data": {k: v for k, v in base_stats_data.items() if k != req_field},
        }))), f"Missing {req_field} field in /api/stats must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "runtime_policy": {**sample_runtime_policy, "config_path": "/etc/dokitool/runtime.json"},
        },
    }))), "Unknown property in RuntimePolicySummary must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "circuit_breakers": sample_circuit_breakers[:13],
        },
    }))), "circuit_breakers with fewer than 14 items must be rejected")
    sample_generic_cb = {
        "platform": "ytdlp_generic",
        "state": "closed",
        "consecutive_failures": 0,
        "window_failures": 0,
        "window_total": 0,
        "open_until": "",
        "disabled_by_config": False,
    }
    require(not list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "generic_circuit_breaker": sample_generic_cb},
    })), "Valid /api/stats payload with generic_circuit_breaker rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "generic_circuit_breaker": {**sample_generic_cb, "platform": "douyin"},
        },
    }))), "generic_circuit_breaker with non-ytdlp_generic platform must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "ytdlp_pools": {k: v for k, v in sample_ytdlp_pools.items() if k != "youtube_ejs"},
        },
    }))), "Missing ytdlp_pools.youtube_ejs in /api/stats must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "admission": {k: v for k, v in base_stats_data["admission"].items() if k != "generic_slow"},
        },
    }))), "Missing admission.generic_slow in /api/stats must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "ytdlp_generic": {**base_stats_data["ytdlp_generic"], "extra": 1},
        },
    }))), "Unknown property in ytdlp_generic must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "api_keys": None},
    }))), "Null api_keys in /api/stats must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "api_keys": [{**sample_api_key, "token_sha256": "1" * 64}]},
    }))), "Unknown property in APIKeyStatsSnapshot must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "api_keys": [{**sample_api_key, "role": "admin"}]},
    }))), "Invalid role in APIKeyStatsSnapshot must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "api_keys": [{**sample_api_key, "id": "Bad_ID"}]},
    }))), "Invalid id pattern in APIKeyStatsSnapshot must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "runtime": {**sample_runtime, "snapshot_path": "example-snapshot.json"}},
    }))), "Unknown property in RuntimeConfigSnapshot must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "runtime": {**sample_runtime, "xhs_transport": "curl"}},
    }))), "Invalid xhs_transport in RuntimeConfigSnapshot must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "requests": {
                **base_stats_data["requests"],
                "by_platform_code_channel": [
                    {"platform": "Bad Platform", "code": "OK", "channel": "owner", "count": 1},
                ],
            },
        },
    }))), "Invalid StatsPlatform pattern must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "daily": [{**sample_daily_bucket, "date": "2026/11/15"}]},
    }))), "Invalid date format in DailyStatsBucket must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "daily": [{**sample_daily_bucket, "latency_ms": {"p50_ms": -1, "p95_ms": 0, "max_ms": 0}}],
        },
    }))), "Negative latency_ms in DailyLatencySummary must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            **base_stats_data,
            "daily": [{
                **sample_daily_bucket,
                "by_platform": {
                    "douyin": {
                        "total": 1,
                        "ok": 1,
                        "failed": 0,
                        "by_code": {"OK": 1},
                        "p95_ms": 100,
                        "extra": True,
                    },
                },
            }],
        },
    }))), "Unknown property in DailyPlatformStats must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "daily": [sample_daily_bucket] * 31},
    }))), "daily array exceeding maxItems=30 must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "hourly": [sample_hourly_bucket] * 25},
    }))), "hourly array exceeding maxItems=24 must be rejected")
    require(bool(list(stats_val.iter_errors({
        "schema_version": "1.0",
        "code": "OK",
        "data": {**base_stats_data, "hourly": [{**sample_hourly_bucket, "extra": 1}]},
    }))), "Unknown property in HourlyStatsBucket must be rejected")

    # Positive & negative checks for Attachment.track_kind on Success envelope
    sample_subtitle_envelope = json.loads((EXAMPLES_DIR / "02-single-video-file.json").read_text(encoding="utf-8"))
    def _with_subtitle_attachment(track_kind_present: bool, track_kind_value=None) -> dict:
        env = json.loads(json.dumps(sample_subtitle_envelope))
        att = {
            "id": "sub-en-manual",
            "role": "subtitle",
            "language": "en",
            "title": "English",
            "resource": {
                "id": "res-sub-en-manual",
                "role": "subtitle",
                "metadata": {
                    "container": "vtt",
                    "extension": "vtt",
                    "mime_type": "text/vtt",
                    "evidence": "upstream",
                },
                "delivery": {
                    "kind": "file",
                    "sources": [
                        {
                            "id": "s-sub-en",
                            "url": "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=vtt",
                            "access": "direct",
                        }
                    ],
                },
            },
        }
        if track_kind_present:
            att["track_kind"] = track_kind_value
        env["data"]["attachments"] = [att]
        return env

    require(not list(success_val.iter_errors(_with_subtitle_attachment(True, "manual"))), "Valid subtitle track_kind='manual' rejected")
    require(not list(success_val.iter_errors(_with_subtitle_attachment(True, "auto"))), "Valid subtitle track_kind='auto' rejected")
    require(not list(success_val.iter_errors(_with_subtitle_attachment(False))), "Valid subtitle with omitted track_kind rejected")
    require(bool(list(success_val.iter_errors(_with_subtitle_attachment(True, "translated")))), "Invalid subtitle track_kind='translated' must be rejected")
    require(bool(list(success_val.iter_errors(_with_subtitle_attachment(True, 123)))), "Non-string subtitle track_kind must be rejected")

    return {"enabled": True, "validated_fixtures": len(fixture_files) + 31 + validate_doc_json_blocks(
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

    require(
        "try_files {path} /index.html" not in caddy,
        "ops/examples/snap.caddy must not use site-wide SPA soft-404 'try_files {path} /index.html'",
    )
    require(
        'header Strict-Transport-Security "max-age=31536000"' in caddy,
        "ops/examples/snap.caddy must declare Strict-Transport-Security header",
    )
    require(
        'header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"' in caddy,
        "ops/examples/snap.caddy must declare Permissions-Policy header",
    )
    require(
        '@download_bridge path /downloads/bridge.html' in caddy
        and '@default_csp not path /monitor /monitor.html /downloads/bridge.html' in caddy,
        "ops/examples/snap.caddy must declare mutually exclusive @download_bridge and @default_csp matchers",
    )
    bridge_csp_match = re.search(r'header\s+@download_bridge\s+Content-Security-Policy\s+"([^"]+)"', caddy)
    require(bridge_csp_match is not None, "ops/examples/snap.caddy must declare @download_bridge Content-Security-Policy")
    bridge_csp_val = bridge_csp_match.group(1)
    bridge_csp_dirs = [part.strip() for part in bridge_csp_val.split(";") if part.strip()]
    for required_dir in (
        "default-src 'none'",
        "script-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
    ):
        require(
            required_dir in bridge_csp_dirs,
            f"ops/examples/snap.caddy @download_bridge CSP missing directive: {required_dir}",
        )
    require(
        "unsafe-inline" not in bridge_csp_val and "unsafe-eval" not in bridge_csp_val,
        "ops/examples/snap.caddy @download_bridge CSP must forbid unsafe-inline and unsafe-eval",
    )
    default_csp_match = re.search(r'header\s+@default_csp\s+Content-Security-Policy\s+"([^"]+)"', caddy)
    require(default_csp_match is not None, "ops/examples/snap.caddy must declare @default_csp Content-Security-Policy")
    default_csp_val = default_csp_match.group(1)
    default_csp_dirs = [part.strip() for part in default_csp_val.split(";") if part.strip()]
    for required_dir in (
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: http: data: blob:",
        "media-src 'self' https: http: blob:",
        "connect-src 'self' https: http:",
        "worker-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ):
        require(
            required_dir in default_csp_dirs,
            f"ops/examples/snap.caddy @default_csp CSP missing directive: {required_dir}",
        )
    require(
        re.search(r"script-src 'self' 'sha256-[A-Za-z0-9+/=]+'", default_csp_val) is not None,
        "ops/examples/snap.caddy @default_csp script-src must pin 'self' and theme bootstrap sha256 hash",
    )
    require(
        "unsafe-eval" not in default_csp_val
        and not any(d.startswith("script-src ") and "unsafe-inline" in d for d in default_csp_dirs),
        "ops/examples/snap.caddy @default_csp script-src must forbid unsafe-inline and unsafe-eval",
    )

    idx_weibo = caddy.find("handle /api/media/weibo {")
    idx_api = caddy.find("handle @api {")
    idx_catchall = caddy.find("handle /api/* {")
    idx_source = caddy.find("handle @source {")
    idx_llms = caddy.find("handle /llms.txt {")
    idx_share = caddy.find("handle /social/dokitool-share-v1.png {")
    idx_monitor = caddy.find("handle @monitor {")
    idx_static_handle = caddy.find("\n    handle {", idx_monitor)
    idx_real_404 = caddy.find("respond 404", idx_static_handle) if idx_static_handle > 0 else -1
    require(
        0 < idx_weibo < idx_api < idx_catchall < idx_source < idx_llms < idx_share < idx_monitor < idx_static_handle < idx_real_404,
        "ops/examples/snap.caddy handle blocks must order /api/media/weibo -> @api -> /api/* 404 -> @source -> /llms.txt -> share -> @monitor -> static real-404",
    )
    static_block = caddy[idx_static_handle:]
    require(
        "precompressed br gzip" in static_block
        and r"(?:\.(?:br|gz))?$" in static_block
        and "@existing_static" in static_block
        and "file {path} {path}/index.html" in static_block,
        "ops/examples/snap.caddy static fallback must enable precompressed br gzip, extended @versioned regex, and real-file-only @existing_static + 404",
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

    monitor_matcher = re.search(r"(?m)^\s*@monitor\s+path\s+(.+?)\s*$", caddy)
    require(monitor_matcher is not None, "ops/examples/snap.caddy must declare '@monitor path /monitor /monitor.html'")
    require(
        monitor_matcher.group(1).split() == ["/monitor", "/monitor.html"],
        f"ops/examples/snap.caddy @monitor paths mismatch: got {monitor_matcher.group(1).split()}",
    )
    monitor_block = caddy[idx_monitor:idx_static_handle]
    require(
        'header Content-Type "text/html; charset=utf-8"' in monitor_block
        and 'header Cache-Control "no-store"' in monitor_block
        and 'header X-Robots-Tag "noindex, nofollow, noarchive"' in monitor_block
        and "rewrite * /monitor.html" in monitor_block
        and "file_server" in monitor_block,
        "ops/examples/snap.caddy handle @monitor must set HTML Content-Type, no-store, noindex/nofollow/noarchive, rewrite * /monitor.html, and file_server",
    )
    csp_match = re.search(r'header\s+Content-Security-Policy\s+"([^"]+)"', monitor_block)
    require(csp_match is not None, "ops/examples/snap.caddy handle @monitor must declare Content-Security-Policy header")
    csp_val = csp_match.group(1)
    csp_directives = [part.strip() for part in csp_val.split(";") if part.strip()]
    for required_dir in (
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ):
        require(
            required_dir in csp_directives,
            f"ops/examples/snap.caddy handle @monitor CSP missing directive: {required_dir}",
        )
    require(
        "unsafe-inline" not in csp_val and "unsafe-eval" not in csp_val,
        "ops/examples/snap.caddy handle @monitor CSP must forbid unsafe-inline and unsafe-eval",
    )

    require(DEPLOYMENT_DOC_PATH.is_file(), f"Missing deployment doc: {DEPLOYMENT_DOC_PATH}")
    deploy_text = DEPLOYMENT_DOC_PATH.read_text(encoding="utf-8")
    require(
        "Caddy" in deploy_text and "白名单" in deploy_text,
        "docs/DEPLOYMENT.md must document updating the Caddy @api whitelist when adding new API paths",
    )
    return len(api_paths)


def check_api_keys_example(platforms_cfg: list[dict]) -> int:
    require(API_KEYS_EXAMPLE_PATH.is_file(), f"Missing API keys example: {API_KEYS_EXAMPLE_PATH}")
    raw_bytes = API_KEYS_EXAMPLE_PATH.read_bytes()
    require(len(raw_bytes) <= 64 * 1024, "ops/examples/api-keys.example.json must not exceed 64 KiB")
    doc = json.loads(raw_bytes.decode("utf-8"))
    require(
        isinstance(doc, dict) and set(doc.keys()) == {"keys"},
        "ops/examples/api-keys.example.json must be a JSON object with only the 'keys' field",
    )
    keys = doc["keys"]
    require(
        isinstance(keys, list) and 1 <= len(keys) <= 64,
        "ops/examples/api-keys.example.json 'keys' must be a non-empty array of <= 64 entries",
    )

    optional_go_platforms = ["x", "youtube", "instagram", "facebook", "tumblr"]
    valid_platforms = {entry["id"] for entry in platforms_cfg} | set(optional_go_platforms)
    require(len(valid_platforms) == 14, "Expected 14 distinct active platform IDs")
    valid_key_platforms = valid_platforms | {"ytdlp_generic"}

    allowed_fields = {
        "id", "role", "enabled", "token_sha256",
        "concurrency", "slow_concurrency", "rps", "burst",
        "queue_size", "queue_wait", "platforms",
    }
    id_re = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
    hex64_re = re.compile(r"^[0-9a-fA-F]{64}$")
    seen_ids: set[str] = set()
    seen_digests: set[str] = set()

    for idx, entry in enumerate(keys):
        require(isinstance(entry, dict), f"api-keys.example.json keys[{idx}] must be an object")
        unknown = set(entry.keys()) - allowed_fields
        require(not unknown, f"api-keys.example.json keys[{idx}] contains unknown fields: {sorted(unknown)}")

        kid = entry.get("id")
        require(isinstance(kid, str) and bool(id_re.fullmatch(kid)), f"Invalid key id at keys[{idx}]: {kid!r}")
        require(kid not in seen_ids, f"Duplicate key id in api-keys.example.json: {kid!r}")
        seen_ids.add(kid)

        role = entry.get("role")
        require(role in EXPECTED_API_KEY_ROLES, f"Invalid role at keys[{idx}]: {role!r}")

        if "enabled" in entry:
            require(isinstance(entry["enabled"], bool), f"keys[{idx}].enabled must be a boolean")

        digest = entry.get("token_sha256")
        require(
            isinstance(digest, str) and bool(hex64_re.fullmatch(digest)),
            f"keys[{idx}].token_sha256 must be 64 hex chars",
        )
        norm_digest = digest.lower()
        require(
            norm_digest != ("0" * 64) and norm_digest != EMPTY_STRING_SHA256,
            f"keys[{idx}].token_sha256 must not be all-zero or empty-string SHA-256",
        )
        require(norm_digest not in seen_digests, f"Duplicate token_sha256 at keys[{idx}]")
        seen_digests.add(norm_digest)

        role_bounds = {
            "owner": (32, 24, 1000.0, 1000, 4096, 120.0, True),
            "agent": (32, 24, 1000.0, 1000, 4096, 120.0, False),
            "friend": (16, 16, 100.0, 200, 512, 60.0, False),
        }[role]
        max_conc, max_slow, max_rps, max_burst, max_qsize, max_qwait_s, allow_zero_rps = role_bounds

        conc = entry.get("concurrency")
        if conc is not None:
            require(
                isinstance(conc, int) and not isinstance(conc, bool) and 1 <= conc <= max_conc,
                f"keys[{idx}].concurrency must be an integer in 1..{max_conc}",
            )
        if "slow_concurrency" in entry:
            sconc = entry["slow_concurrency"]
            eff_conc = conc if conc is not None else (8 if role == "owner" else (4 if role == "agent" else 2))
            require(
                isinstance(sconc, int) and not isinstance(sconc, bool) and 0 <= sconc <= min(max_slow, eff_conc),
                f"keys[{idx}].slow_concurrency must satisfy 0 <= slow_concurrency <= min({max_slow}, concurrency)",
            )
        if "rps" in entry:
            rps = entry["rps"]
            require(
                isinstance(rps, (int, float)) and not isinstance(rps, bool),
                f"keys[{idx}].rps must be a number",
            )
            if allow_zero_rps and rps == 0:
                require(entry.get("burst", 0) == 0, f"keys[{idx}].burst must be 0 when rps == 0")
            else:
                require(0 < float(rps) <= max_rps, f"keys[{idx}].rps out of bounds for role {role}")
        if "burst" in entry:
            burst = entry["burst"]
            require(
                isinstance(burst, int) and not isinstance(burst, bool),
                f"keys[{idx}].burst must be an integer",
            )
            if not (allow_zero_rps and entry.get("rps", 0) == 0 and burst == 0):
                require(1 <= burst <= max_burst, f"keys[{idx}].burst must be in 1..{max_burst}")
        if "queue_size" in entry:
            qsize = entry["queue_size"]
            require(
                isinstance(qsize, int) and not isinstance(qsize, bool) and 0 <= qsize <= max_qsize,
                f"keys[{idx}].queue_size must be in 0..{max_qsize}",
            )
        if "queue_wait" in entry:
            qwait = entry["queue_wait"]
            m_dur = re.fullmatch(r"^(\d+(?:\.\d+)?)(ms|s|m)$", qwait) if isinstance(qwait, str) else None
            require(m_dur is not None, f"keys[{idx}].queue_wait must be a valid Go duration string: {qwait!r}")
            val = float(m_dur.group(1))
            unit = m_dur.group(2)
            secs = val / 1000.0 if unit == "ms" else (val * 60.0 if unit == "m" else val)
            require(0.0 <= secs <= max_qwait_s, f"keys[{idx}].queue_wait out of bounds for role {role}")

        if "platforms" in entry:
            plats = entry["platforms"]
            require(isinstance(plats, list) and len(plats) >= 1, f"keys[{idx}].platforms must be a non-empty list")
            require(len(plats) == len(set(plats)), f"keys[{idx}].platforms must not contain duplicates")
            for plat in plats:
                require(
                    isinstance(plat, str) and plat in valid_key_platforms,
                    f"keys[{idx}].platforms contains invalid platform {plat!r}",
                )

    return len(keys)


def _parse_go_duration_seconds(raw: object, field_name: str) -> float:
    require(isinstance(raw, str) and bool(raw.strip()), f"{field_name} must be a non-empty Go duration string")
    text = raw.strip()
    if text == "0":
        return 0.0
    m = re.fullmatch(r"^(\d+(?:\.\d+)?)(ms|s|m)$", text)
    require(m is not None, f"{field_name} must be a valid Go duration string: {raw!r}")
    val = float(m.group(1))
    unit = m.group(2)
    return val / 1000.0 if unit == "ms" else (val * 60.0 if unit == "m" else val)


def check_runtime_config_example(platforms_cfg: list[dict]) -> bool:
    require(RUNTIME_CONFIG_EXAMPLE_PATH.is_file(), f"Missing runtime config example: {RUNTIME_CONFIG_EXAMPLE_PATH}")
    raw_bytes = RUNTIME_CONFIG_EXAMPLE_PATH.read_bytes()
    require(len(raw_bytes) <= 64 * 1024, "ops/examples/runtime.example.json must not exceed 64 KiB")
    doc = json.loads(raw_bytes.decode("utf-8"))
    require(
        isinstance(doc, dict)
        and set(doc.keys()) == {"schema_version", "ytdlp", "fast_pool", "circuit_breaker", "cache"},
        "ops/examples/runtime.example.json must contain exact top-level sections",
    )
    require(doc["schema_version"] == "1.0", "runtime.example.json schema_version must be '1.0'")

    optional_go_platforms = ["x", "youtube", "instagram", "facebook", "tumblr"]
    valid_platforms = {entry["id"] for entry in platforms_cfg} | set(optional_go_platforms) | {"ytdlp_generic"}
    require(len(valid_platforms) == 15, "Expected 14 core platforms + ytdlp_generic")

    def require_int_range(obj: dict, key: str, lo: int, hi: int, prefix: str) -> int:
        val = obj.get(key)
        require(
            isinstance(val, int) and not isinstance(val, bool) and lo <= val <= hi,
            f"runtime.example.json {prefix}.{key} must be int in {lo}..{hi}",
        )
        return val

    ytdlp = doc["ytdlp"]
    require(
        isinstance(ytdlp, dict)
        and set(ytdlp.keys()) == {
            "youtube_slots", "youtube_queue_size", "youtube_queue_wait",
            "social_slots", "social_queue_size", "social_queue_wait",
            "generic_slots", "generic_queue_size", "generic_queue_wait",
            "youtube_ejs_concurrency", "youtube_ejs_queue_size", "youtube_ejs_queue_wait",
        },
        "runtime.example.json ytdlp keys mismatch",
    )
    yt_slots = require_int_range(ytdlp, "youtube_slots", 1, 16, "ytdlp")
    soc_slots = require_int_range(ytdlp, "social_slots", 1, 16, "ytdlp")
    gen_slots = require_int_range(ytdlp, "generic_slots", 1, 12, "ytdlp")
    require(yt_slots + soc_slots + gen_slots <= 32, "runtime.example.json total yt-dlp slots must be <= 32")
    require_int_range(ytdlp, "youtube_ejs_concurrency", 1, 16, "ytdlp")
    for q_key in ("youtube_queue_size", "social_queue_size", "generic_queue_size", "youtube_ejs_queue_size"):
        require_int_range(ytdlp, q_key, 0, 1024, "ytdlp")
    for w_key in ("youtube_queue_wait", "social_queue_wait", "generic_queue_wait", "youtube_ejs_queue_wait"):
        secs = _parse_go_duration_seconds(ytdlp.get(w_key), f"ytdlp.{w_key}")
        require(0.0 <= secs <= 30.0, f"runtime.example.json ytdlp.{w_key} must be in 0s..30s")

    fast_pool = doc["fast_pool"]
    require(
        isinstance(fast_pool, dict) and set(fast_pool.keys()) == {"per_platform_max_concurrency"},
        "runtime.example.json fast_pool keys mismatch",
    )
    require_int_range(fast_pool, "per_platform_max_concurrency", 2, 256, "fast_pool")

    cb = doc["circuit_breaker"]
    require(
        isinstance(cb, dict)
        and set(cb.keys()) == {
            "enabled", "consecutive_failures", "window_size", "failure_rate_threshold",
            "open_duration", "half_open_max_probes", "disabled_platforms",
        },
        "runtime.example.json circuit_breaker keys mismatch",
    )
    require(isinstance(cb.get("enabled"), bool), "runtime.example.json circuit_breaker.enabled must be boolean")
    require_int_range(cb, "consecutive_failures", 1, 100, "circuit_breaker")
    require_int_range(cb, "window_size", 1, 200, "circuit_breaker")
    fr = cb.get("failure_rate_threshold")
    require(
        isinstance(fr, (int, float)) and not isinstance(fr, bool) and 0.0 < float(fr) <= 1.0,
        "runtime.example.json circuit_breaker.failure_rate_threshold must satisfy 0.0 < v <= 1.0",
    )
    open_secs = _parse_go_duration_seconds(cb.get("open_duration"), "circuit_breaker.open_duration")
    require(5.0 <= open_secs <= 600.0, "runtime.example.json circuit_breaker.open_duration must be in 5s..600s")
    require_int_range(cb, "half_open_max_probes", 1, 16, "circuit_breaker")
    disabled_plats = cb.get("disabled_platforms")
    require(isinstance(disabled_plats, list), "runtime.example.json circuit_breaker.disabled_platforms must be a list")
    require(len(disabled_plats) == len(set(disabled_plats)), "runtime.example.json disabled_platforms must not contain duplicates")
    for p in disabled_plats:
        require(isinstance(p, str) and p in valid_platforms, f"Invalid disabled platform in runtime.example.json: {p!r}")

    cache = doc["cache"]
    require(
        isinstance(cache, dict)
        and set(cache.keys()) == {"youtube_parse_ttl", "stale_if_error_ttl", "upstream_blocked_neg_ttl"},
        "runtime.example.json cache keys mismatch",
    )
    yt_ttl = _parse_go_duration_seconds(cache.get("youtube_parse_ttl"), "cache.youtube_parse_ttl")
    stale_ttl = _parse_go_duration_seconds(cache.get("stale_if_error_ttl"), "cache.stale_if_error_ttl")
    neg_ttl = _parse_go_duration_seconds(cache.get("upstream_blocked_neg_ttl"), "cache.upstream_blocked_neg_ttl")
    require(0.0 <= yt_ttl <= 600.0, "runtime.example.json cache.youtube_parse_ttl must be in 0s..600s")
    require(0.0 <= stale_ttl <= 3600.0, "runtime.example.json cache.stale_if_error_ttl must be in 0s..3600s")
    require(0.0 <= neg_ttl <= 60.0, "runtime.example.json cache.upstream_blocked_neg_ttl must be in 0s..60s")
    return True


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

    # CDN Referer rules: Weibo + Bilibili (including narrow Akamai UPOS only, never generic Akamai)
    for bili_url in (
        "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/demo.m4s",
        "https://cn-sh-fx-01.bilivideo.cn/upgcxcode/12/34/demo.mp4",
        "https://i0.hdslb.com/bfs/archive/cover.jpg",
        "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/demo.m4s",
        "https://bili-overseas.akamaized.net/stream/demo.mp4",
        "https://generic-edge.akamaized.net/upgcxcode/12/34/demo.mp4",
    ):
        hdrs = mod.cdn_headers_for_url(bili_url)
        require(
            hdrs.get("Referer") == "https://www.bilibili.com/" and "Cookie" not in hdrs and "Authorization" not in hdrs,
            f"Expected Bilibili Referer without credentials for {bili_url}, got {hdrs}",
        )
    vimeo_akamai_hdrs = mod.cdn_headers_for_url("https://vod-progressive.akamaized.net/exp/clip.mp4")
    require(
        "Referer" not in vimeo_akamai_hdrs,
        f"Non-Bilibili Akamai URL must not receive Bilibili Referer, got {vimeo_akamai_hdrs}",
    )

    # 503 circuit-breaker retryable backoff vs non-retryable 503 fail-fast
    retry_503_calls = {"n": 0}
    sleeps: list[float] = []

    class Retry503Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            pass

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/api/parse?retry503"):
                retry_503_calls["n"] += 1
                if retry_503_calls["n"] == 1:
                    body = json.dumps({
                        "schema_version": "1.0",
                        "code": "UPSTREAM_UNAVAILABLE",
                        "error": {"code": "UPSTREAM_UNAVAILABLE", "message": "breaker open", "retryable": True, "retry_after_seconds": 2},
                    }).encode("utf-8")
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Retry-After", "2")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = json.dumps({"schema_version": "1.0", "code": "OK", "data": {}}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = json.dumps({
                "schema_version": "1.0",
                "code": "SERVICE_NOT_CONFIGURED",
                "error": {"code": "SERVICE_NOT_CONFIGURED", "message": "disabled", "retryable": False},
            }).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    retry_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Retry503Handler)
    retry_thread = threading.Thread(target=retry_srv.serve_forever, daemon=True)
    retry_thread.start()
    try:
        rclient = mod.AgentClient(f"http://127.0.0.1:{retry_srv.server_port}", "t" * 64, threading.Event())
        rclient._sleep = lambda sec: sleeps.append(sec)  # type: ignore[method-assign]
        ok_res = rclient.api_get("/api/parse?retry503=1")
        require(
            ok_res.get("code") == "OK" and retry_503_calls["n"] == 2 and len(sleeps) == 1 and 2.0 <= sleeps[0] <= 2.3,
            f"Retryable 503 circuit-breaker backoff failed: res={ok_res} calls={retry_503_calls} sleeps={sleeps}",
        )
        try:
            rclient.api_get("/api/parse?nonretry503=1")
            require(False, "Non-retryable 503 SERVICE_NOT_CONFIGURED must raise PermanentAPIError")
        except mod.PermanentAPIError as exc:
            require(
                exc.status == 503 and exc.code == "SERVICE_NOT_CONFIGURED" and len(sleeps) == 1,
                f"Non-retryable 503 should fail immediately without sleeping: {exc} sleeps={sleeps}",
            )
    finally:
        retry_srv.shutdown()
        retry_srv.server_close()
        retry_thread.join(timeout=5.0)

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
    api_keys_count = check_api_keys_example(platforms_cfg)
    runtime_cfg_ok = check_runtime_config_example(platforms_cfg)
    batch_report = check_batch_downloader_behavior()

    summary = {
        "openapi": spec["openapi"],
        "paths": sorted(spec["paths"].keys()),
        "schemas": len(spec["components"]["schemas"]),
        "resolved_refs": ref_count,
        "agent_api_json_examples": doc_blocks,
        "jsonschema_draft2020_12": js_report,
        "caddy_whitelisted_paths": caddy_paths,
        "api_keys_example_entries": api_keys_count,
        "runtime_config_example_valid": runtime_cfg_ok,
        "example_script_compiled": True,
        "batch_downloader_tests": batch_report,
        "passed": True,
    }
    print(json.dumps(summary, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
