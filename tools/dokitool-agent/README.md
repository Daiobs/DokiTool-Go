# `tools/dokitool-agent` — Zero-Dependency CLI & Stdio MCP Server

A self-contained, zero-third-party-dependency Python 3.9+ standard-library toolkit for interacting with any DokiTool Unified Media v1 (`schema_version=1.0`) API instance:

- **Single-URL CLI** (`platforms`, `parse`, `subtitles`, opt-in `download`, `mcp`).
- **Client-side subtitle discovery & extraction** leveraging Unified-v1 `Attachment.track_kind` (`manual` | `auto`), language priority matching, format ranking (`vtt > srt > ttml > srv3`), hard `5 MiB` track cap, and pure-stdlib conversion to plain text, VTT, SRT, or raw.
- **Default 100% read-only JSON-RPC 2.0 stdio MCP server** with explicit opt-in gating for local writes (`--allow-write --output-dir <dir>`) and local `ffmpeg` muxing (`--allow-ffmpeg`).
- **Agent skill file**: see [SKILL.md](SKILL.md).

## Requirements

- **Python 3.9+** (standard library only; zero `pip` packages).
- Optional: `ffmpeg` on `PATH` only if you explicitly enable `--allow-ffmpeg` to mux split `mux` variants.

## Module Layout

| File | Responsibility |
| --- | --- |
| `security.py` | Env-only token loader, `--api-base` check, secondary client-side anti-SSRF & DNS/redirect validator, zero-Cookie bounded HTTP fetcher, narrow Bilibili `Referer` helper, output-root path & symlink jail, token/URL redaction. |
| `api_client.py` | Unified-v1 API client (`platforms`, `parse`, `resolve`, `refresh_url` fallback), HTTP `401` immediate abort, `429 Retry-After` and retryable `503`/`502`/`504` backoff, normalized summary builders. |
| `subtitles.py` | `Attachment.track_kind` discovery/filtering, language prefix/exact ranking, `<= 5 MiB` client fetch, pure-stdlib VTT/SRT/TTML/SRV3/XML parsing and rendering (`text`/`vtt`/`srt`/`raw`). |
| `downloader.py` | Explicit opt-in media & subtitle writer strictly jailed to `--output-dir`, atomic `.part` to target replacement, `403`/`410` single refresh retry, opt-in `ffmpeg` muxer (`shell=False`). |
| `mcp_server.py` | Pure-stdlib newline-delimited JSON-RPC 2.0 stdio MCP server (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). |
| `cli.py` | Argument parser (`allow_abbrev=False`), `--token`/`-t` rejection, subcommand handlers, JSON/text output formatting. |
| `dokitool_agent.py` | Directly executable entrypoint and high-level Python facade. |

## Security Model

1. **No `--token` / `-t` CLI flags**: Tokens are read exclusively from `DOKITOOL_API_TOKEN` (fallback: `DOKITOOL_OWNER_TOKEN`) and sent only as `Authorization: Bearer <token>` to `--api-base` (never forwarded to CDNs, never followed across HTTP redirects).
2. **HTTPS enforcement for API origin**: Non-loopback `--api-base` must use `https://`. Plaintext `http://` is permitted only for local loopback instances (`127.0.0.1`, `localhost`, `::1`).
3. **Secondary client-side anti-SSRF**: Every media, subtitle, and redirect hop URL is validated for `http`/`https` scheme, no userinfo, no private/loopback/link-local/CGNAT/ULA/unspecified IPs, no `.localhost`/`.local`/`.internal` suffixes, and DNS resolution to globally routable IPs only.
4. **Zero Cookie & narrow Referer**: Custom `OpenerDirector` omits `HTTPCookieProcessor`, `HTTPRedirectHandler`, `FileHandler`, and `FTPHandler`. `Referer: https://www.bilibili.com/` is attached only to narrow Bilibili CDN hosts (`bilivideo.com`, `bilivideo.cn`, `upos-*.akamaized.net`, `*bili*.akamaized.net`, `/upgcxcode/`).
5. **Read-only MCP default & jailed writes**: Without `--allow-write --output-dir <dir>`, `dokitool_download_media` is absent from `tools/list` and rejected by `tools/call`. With opt-in enabled, all writes resolve inside `--output-dir` via `Path.resolve()` + `relative_to()` with strict rejection of `..`, absolute paths, and symlinks.
6. **Redacted diagnostics**: Tokens, `Bearer` headers, and URL query strings are redacted from stderr logs, CLI errors, and MCP error payloads.

## Usage Examples

```bash
export DOKITOOL_API_BASE="https://snap.example.com"
export DOKITOOL_API_TOKEN="<your-token-from-secret-store>"

# List platforms
python3 tools/dokitool-agent/dokitool_agent.py platforms --format text

# Parse a URL (and resolve a deferred item if needed)
python3 tools/dokitool-agent/dokitool_agent.py parse "https://example.com/video/123"
python3 tools/dokitool-agent/dokitool_agent.py parse "https://example.com/video/123" --resolve-item p2

# Inspect or extract subtitles (read-only by default)
python3 tools/dokitool-agent/dokitool_agent.py subtitles "https://example.com/video/123" --list-only
python3 tools/dokitool-agent/dokitool_agent.py subtitles "https://example.com/video/123" \
  --lang zh,en --track-kind manual --sub-format srt --format text

# Opt-in local download (jailed to --output-dir)
python3 tools/dokitool-agent/dokitool_agent.py download "https://example.com/video/123" \
  --allow-write --output-dir ./downloads --with-subtitles --lang en

# Start stdio MCP server (read-only default)
python3 tools/dokitool-agent/dokitool_agent.py mcp

# Start stdio MCP server with opt-in write jail (+ optional --allow-ffmpeg)
python3 tools/dokitool-agent/dokitool_agent.py mcp --allow-write --output-dir ./downloads
```

## MCP Tools

| Tool | Availability | Purpose |
| --- | --- | --- |
| `dokitool_list_platforms` | Always (read-only) | Return enabled platforms and capabilities. |
| `dokitool_parse_media` | Always (read-only) | Parse a single URL (with optional `resolve_item_id`) into a normalized summary. |
| `dokitool_extract_subtitles` | Always (read-only) | Discover and fetch public subtitles (`<= 5 MiB`) as `text`, `vtt`, `srt`, or `raw`. |
| `dokitool_download_media` | Only with `--allow-write --output-dir` | Save media (and optional subtitles) atomically inside `--output-dir`; `mux` variants additionally require `--allow-ffmpeg`. |

## Running Offline Unit Tests

```bash
python3 -m unittest discover -s tools/dokitool-agent/tests -p 'test_*.py' -v
```
