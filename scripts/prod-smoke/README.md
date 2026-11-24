# `scripts/prod-smoke` — 生产冒烟检查工具

面向生产环境（默认 `https://snap.dokitool.com`）与预演环境的零第三方依赖只读冒烟检查工具（仅依赖 Python 3 标准库，兼容 macOS 与 Windows）。

## 安全与配额边界

1. **只读同源请求与连接复用**：仅向 `--base-url` 指定的站点源发送 `GET` 请求；不跟随任何 HTTP 重定向（`301`/`302`/`307`/`308`），绝不请求第三方媒体 CDN，也绝不请求 `/api/media/*` 中转流。同源请求复用持久化 `http.client.HTTPConnection` / `HTTPSConnection`（HTTP/1.1 Keep-Alive 连接池）；双栈网络下首次连接若触发 IPv6 超时/不可达回退，后续同主机请求会缓存已连通的地址族，避免 Windows 双栈环境反复等待 IPv6 回退。
2. **零凭据发送**：不使用 Cookie 容器，禁止发送 `Cookie`、`Authorization`、`Proxy-Authorization` 或任何内部认证请求头；若环境代理 URL 含凭据直接拒绝执行。
3. **可控小并发、自限速与自动重试**：
   - `frontend_hashes` 静态文件校验默认启用可控小并发（`--frontend-concurrency`，默认 `6`，合法范围 `1..8`）并复用同源 Keep-Alive 连接池，保持报错摘要顺序确定；所有 `/api/parse`、接口边界与限流检查均严格串行执行。
   - 常规 `/api/parse` 请求之间强制间隔 **`>= 8.0s`**，单次运行不会误触匿名访客限流（`ClientBurst=4, ClientRPS=0.2`）。
   - 涉及第三方平台的解析检查失败时，自动间隔 **`10.0s`** 重试，最多 **`3` 次尝试**（首次通过记 `retry_count=0`，第 2 次通过记 `1`，第 3 次通过或 3 次均失败记 `2`）。
   - 同一轮运行内，若多个检查组共享同一公开样本 URL 且前序已拿到合法的 `200 OK` 响应，后续派生断言会优先复用该响应以节省上游配额（`cache` 组除外，`cache` 始终实际发送 2 次间隔 `>= 8.0s` 的独立请求比对原始字节 SHA-256 与 `generated_at`）。
   - `api_boundary` 接口边界检查组（无头请求 `GET /api/stats?schema_version=1.0` 与随机未白名单路径 `GET /api/<random>`）不计入 `/api/parse` 的 `8.0s` 间隔；因未鉴权 `/api/stats` 会消耗本机 `1` 次匿名访客限流额度，该组固定排在**所有 `/api/parse` 解析检查组之后**（且在可选突发限流检查 `rate_limit` 之前）执行。
4. **严格输出脱敏**：输出的 Markdown 结论表与 JSON 报告仅保留去重后的**媒体域名（`media_hostnames`）**，程序化擦除并校验输出中不包含完整媒体 URL、查询参数/签名、`xsec_token`、中转 `ticket` 或任何 IPv4/IPv6 地址。

## 检查组（Check Groups）

| 检查组 | 默认状态 | 检查内容 |
| --- | --- | --- |
| `frontend_hashes` | 传 `--manifest` 时执行，否则 `SKIP` | 对照构建产物 `release-manifest.json` 的 `frontend_dist_files`，逐文件（含 `/`、`index.html`、油猴脚本等）校验线上静态文件原始字节 SHA-256 |
| `platforms` | 开启 | `GET /api/platforms?schema_version=1.0` 返回 `200 OK`，`data.platforms` 长度为 `14` 且 14 个平台 ID 完整匹配 |
| `cache` | 开启 | 对缓存样本连续发起 2 次间隔 `>= 8.0s` 的 `/api/parse`，校验两次响应原始字节 SHA-256 与 `generated_at` 完全一致 |
| `x_fast_path` | 开启 | 校验 X 视频样本返回 `200 OK` 且包含 `https://video.twimg.com` MP4 `file` 直链规格 |
| `douyin_domestic` | 开启 | 校验抖音样本媒体域名包含 `*.douyinvod.com`（确认上海 `pull` 解析通道生效） |
| `direct_markers` | 开启 | 校验 `douyin`、`xiaohongshu`（同时要求全部媒体源 `100%` 为 `https://`，`0` 个 `http://`）、`kuaishou`、`pipixia` 已验证 HTTPS CDN 源带 `browser_fetch: "allowed"` |
| `all_platforms` | 开启 | 校验全部 14 个支持平台均返回合法的 `200 OK` 统一协议响应与可用媒体源 |
| `api_boundary` | 开启（排在全部解析检查之后） | 校验接口鉴权与网关白名单边界（不触发 `/api/parse` 8s 间隔）：① `GET /api/stats?schema_version=1.0` 不带头返回 `401` JSON（`code: "INVALID_INPUT"`）；② 随机未白名单路径 `GET /api/<random>` 返回 `404` JSON（`code: "INVALID_INPUT"`，拒绝 HTML/纯文本兜底） |
| `rate_limit` | **默认关闭**（需传 `--enable-rate-limit`） | 在最后阶段先等待限流桶补满，再连续快速发送 6 个不同 URL 的 `/api/parse`，校验前序 `200 OK`、超额返回 `429 RATE_LIMITED` 且 `retry_after_seconds > 0` |

## 常用命令（macOS / Windows 通用）

```bash
# 1. 标准生产冒烟（含前端构建产物 SHA-256 校验，同时输出 Markdown 表与 JSON 文件）
python3 scripts/prod-smoke/smoke.py \
  --base-url https://snap.dokitool.com \
  --manifest /path/to/release-manifest.json \
  --md-out smoke-summary.md \
  --json-out smoke-report.json

# Windows PowerShell 等价命令：
# py -3 scripts/prod-smoke/smoke.py --base-url https://snap.dokitool.com --manifest C:\temp\release-manifest.json

# 2. 只跑指定检查组（例如仅验证平台列表与接口边界，不发起 /api/parse）
python3 scripts/prod-smoke/smoke.py \
  --only platforms,api_boundary

# 3. 临时替换单个过期样本（例如替换小红书公开样本链接，输出会自动脱敏参数）
python3 scripts/prod-smoke/smoke.py \
  --only direct_markers \
  --set-sample "xiaohongshu=https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>&xsec_source=pc_feed"

# 4. 显式开启匿名限流突发检查（排在所有常规检查之后运行）
python3 scripts/prod-smoke/smoke.py \
  --only platforms,rate_limit \
  --enable-rate-limit

# 5. 运行离线单元测试（零外网请求）
python3 -B scripts/prod-smoke/test_smoke.py
```

退出码约定：所有实际执行的检查项无 `FAIL`（`FAIL == 0`）时退出码为 `0`；任一检查项 `FAIL` 或参数错误时退出码为 `1`。
