---
name: dokitool-agent
description: Zero-dependency DokiTool Agent CLI and default read-only stdio MCP server for single-URL media parsing, Unified-v1 subtitle extraction (manual/auto track_kind), and explicit opt-in local downloads.
---

# DokiTool Agent Skill (`tools/dokitool-agent`)

Use this skill whenever an AI agent or automation script needs to inspect supported platforms, parse a single share URL/text via the DokiTool Unified Media v1 API (`schema_version=1.0`), extract public subtitles directly on the client, or optionally download media into a jailed output directory.

## Security Guardrails (Mandatory)

1. **Env-only authentication (NEVER pass `--token` or `-t`)**:
   - Configure `DOKITOOL_API_TOKEN` (preferred) or `DOKITOOL_OWNER_TOKEN` in the process environment.
   - Passing `--token` or `-t` on the command line is rejected with exit code `2` so secrets never leak via process `argv`/`ps` or shell history.
   - Never print tokens, `Authorization` headers, or signed CDN query strings into logs, issues, or tool outputs.
2. **Read-only by default**:
   - CLI `platforms`, `parse`, and `subtitles` (without `--allow-write`) and MCP server `mcp` perform zero local file writes and zero subprocess executions.
   - Local file writing ALWAYS requires BOTH `--allow-write` and `--output-dir <dir>` (all writes are canonicalized and strictly jailed inside `--output-dir`; `..`, absolute paths, and symlinks are rejected).
   - Local `ffmpeg` muxing for `mux` delivery variants requires explicit `--allow-ffmpeg` in addition to `--allow-write --output-dir <dir>`.
3. **Zero-Cookie, zero server media proxying, secondary anti-SSRF & proxy boundary**:
   - Subtitles and media are fetched directly from CDN/timedtext URLs with zero `Cookie` storage/transmission and a hard `5 MiB` cap per subtitle track.
   - Every media, subtitle, and HTTP redirect hop URL is validated client-side against private/loopback/link-local/CGNAT/internal targets and DNS resolution. In direct mode (or with `--no-proxy`), the transport pins the connection to the validated public IP while preserving `Host` and TLS SNI (`server_hostname`) to prevent DNS rebinding TOCTOU.
   - **Proxy trust boundary**: when `HTTP_PROXY` / `HTTPS_PROXY` is configured in the environment and `--no-proxy` is NOT passed, outbound routing and remote DNS resolution are trusted to the user-configured proxy server. Pass `--no-proxy` on any subcommand (`platforms`, `parse`, `subtitles`, `download`, `mcp`) to force direct IP-pinned connections.
   - `Referer: https://www.bilibili.com/` is sent only to narrow Bilibili CDN hosts (`bilivideo.com`, `bilivideo.cn`, `upos-*.akamaized.net`, `*bili*.akamaized.net`, `/upgcxcode/`); zero `Referer` is sent elsewhere.

## Platform Notes

- **Subtitles**: Uses Unified-v1 `data.attachments[role="subtitle"]` with `track_kind: "manual" | "auto"` (YouTube & `ytengine` public captions). Bilibili AI/CC subtitles require login cookies and are intentionally unsupported under the zero-Cookie rule.
- **YouTube**: Standard web/extension flows use the browser YouTube Helper; on instances without `DOKITOOL_YTDLP_YOUTUBE_ENABLED`, `/api/parse` returns HTTP `503 SERVICE_NOT_CONFIGURED`.

## CLI Quick Reference

All commands use Python 3.9+ standard library only (`pip install` is not required).

```bash
export DOKITOOL_API_BASE="https://snap.example.com"
export DOKITOOL_API_TOKEN="<your-token-from-secret-store>"

# 1. List enabled platforms
python3 tools/dokitool-agent/dokitool_agent.py platforms

# 2. Parse a single share URL (JSON summary by default; add --raw for full envelope)
python3 tools/dokitool-agent/dokitool_agent.py parse "https://example.com/video/123"

# 3. List available subtitle tracks without downloading bodies
python3 tools/dokitool-agent/dokitool_agent.py subtitles "https://example.com/video/123" --list-only

# 4. Extract manual Chinese or English subtitle as plain text transcript (read-only)
python3 tools/dokitool-agent/dokitool_agent.py subtitles "https://example.com/video/123" \
  --lang zh,en --track-kind manual --sub-format text --format text

# 5. Explicit opt-in local download (strictly jailed to --output-dir)
python3 tools/dokitool-agent/dokitool_agent.py download "https://example.com/video/123" \
  --allow-write --output-dir ./downloads --with-subtitles --lang en --sub-format vtt

# 6. Explicit opt-in local muxing with ffmpeg (only when variant delivery.kind == "mux")
python3 tools/dokitool-agent/dokitool_agent.py download "https://example.com/video/123" \
  --allow-write --output-dir ./downloads --allow-ffmpeg
```

## MCP Server Configuration

### Read-Only Default (Recommended)

Exposes ONLY `dokitool_list_platforms`, `dokitool_parse_media`, and `dokitool_extract_subtitles`:

```json
{
  "mcpServers": {
    "dokitool": {
      "command": "python3",
      "args": ["tools/dokitool-agent/dokitool_agent.py", "mcp"],
      "env": {
        "DOKITOOL_API_BASE": "https://snap.example.com",
        "DOKITOOL_API_TOKEN": "<your-token-from-secret-store>"
      }
    }
  }
}
```

### Explicit Opt-In Write Mode (Optional)

Adds `dokitool_download_media`, strictly jailed to `--output-dir` (add `"--allow-ffmpeg"` only if local `ffmpeg` muxing is explicitly needed):

```json
{
  "mcpServers": {
    "dokitool": {
      "command": "python3",
      "args": [
        "tools/dokitool-agent/dokitool_agent.py",
        "mcp",
        "--allow-write",
        "--output-dir",
        "./downloads"
      ],
      "env": {
        "DOKITOOL_API_BASE": "https://snap.example.com",
        "DOKITOOL_API_TOKEN": "<your-token-from-secret-store>"
      }
    }
  }
}
```
