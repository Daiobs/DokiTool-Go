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
| `frontend_hashes` | 传 `--manifest` 时执行，否则 `SKIP` | 对照构建产物 `release-manifest.json` 的 `frontend_dist_files`，逐文件（含 `/`、`index.html`、`/helper/extension-version.json`、`/helper/dokitool-chrome-extension.zip` 等）校验线上静态文件原始字节 SHA-256 |
| `platforms` | 开启 | `GET /api/platforms?schema_version=1.0` 返回 `200 OK`，`data.platforms` 长度为 `14` 且 14 个平台 ID 完整匹配 |
| `youtube_context` | 开启 | `GET /api/youtube/context?schema_version=1.0` 返回 `200 OK` 与有效 `player_id`/`expires_at`；延迟超过阈值（默认 `2000ms`，可由 `--youtube-context-warn-ms` 覆写）触发 `WARN` 预警，超过失败阈值触发 `FAIL` |
| `cache` | 开启 | 对缓存样本连续发起 2 次间隔 `>= 8.0s` 的 `/api/parse`，校验两次响应原始字节 SHA-256 与 `generated_at` 完全一致 |
| `x_fast_path` | 开启 | 校验 X 视频样本返回 `200 OK` 且包含 `https://video.twimg.com` MP4 `file` 直链规格 |
| `douyin_domestic` | 开启 | 校验抖音样本媒体域名包含 `*.douyinvod.com`（确认上海 `pull` 解析通道生效） |
| `direct_markers` | 开启 | 校验 `douyin`、`xiaohongshu`（同时要求全部媒体源 `100%` 为 `https://`，`0` 个 `http://`）、`kuaishou`、`pipixia` 已验证 HTTPS CDN 源带 `browser_fetch: "allowed"` |
| `all_platforms` | 开启（`--tier tier-a` / `all`） | 校验 Tier-A 全部 14 个核心平台均返回合法的 `200 OK` 统一协议响应、非空且非占位符 `title`（拒绝 `P1`/`未知标题`）与可用媒体源；上游作品下架/删除（`CONTENT_UNAVAILABLE` / 404 下架）归类为 `SAMPLE_STALE` 与真实解析器故障 `FAIL` 隔离 |
| `tier_b_platforms` | 默认 `SKIP`（传 `--tier tier-b` / `all` 或 `--only tier_b_platforms` 开启） | 校验 Tier-B 长尾站点轮询池（支持 `--tier-b-limit <N>` 按 UTC 日序轮转抽样） |
| `api_boundary` | 开启（排在全部解析检查之后） | 校验接口鉴权与网关白名单边界（不触发 `/api/parse` 8s 间隔）：① `GET /api/stats?schema_version=1.0` 不带头返回 `401` JSON（`code: "INVALID_INPUT"`）；② 随机未白名单路径 `GET /api/<random>` 返回 `404` JSON（`code: "INVALID_INPUT"`，拒绝 HTML/纯文本兜底） |
| `rate_limit` | **默认关闭**（需传 `--enable-rate-limit`） | 在最后阶段先等待限流桶补满，再连续快速发送 6 个不同 URL 的 `/api/parse`，校验前序 `200 OK`、超额返回 `429 RATE_LIMITED` 且 `retry_after_seconds > 0` |

新增 L4 参数：`--tier {tier-a,tier-b,all}`（默认 `tier-a`）、`--tier-b-limit <N>`、`--youtube-context-warn-ms <ms>`、`--strict-stale`（将 `SAMPLE_STALE` 也视为非零退出）。

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

---

## `stage2_browser.mjs` — 阶段二无头静默浏览器验收工具

面向发布阶段二（Section D）的零第三方依赖无头 Chrome 验收工具（仅依赖 Node 22/24 标准库并复用 `scripts/download-browser-session.mjs`），用于自动化验证真实浏览器水合、Service Worker 桥接、`/monitor` 响应式布局及**零修改官方 Chrome 扩展（免油猴）**握手与解析链路。

### 核心约束与安全特性

1. **强制无头静默与零残留**：所有 Chrome 实例均以独立临时 `--user-data-dir` 与 `--headless=new --no-first-run --no-default-browser-check --use-mock-keychain --password-store=basic` 后台启动，严禁弹窗或抢占桌面焦点；退出（含 `finally` 与 `SIGINT`/`SIGTERM`）强制回收子进程树与临时目录，并校验 `RESIDUAL_CHROME=0`。
2. **自动环境探测（零本机硬编码）**：按 `--chrome-bin` → `DOKITOOL_CHROME_BIN` → Playwright 缓存最新 `Google Chrome for Testing` → 系统 Chrome/Chromium 依次探测；网络代理按 `--proxy` → `HTTPS_PROXY` / `HTTP_PROXY`（遵守 `NO_PROXY` 且回环地址始终直连）自动适配，拒绝 URL 或代理 URL 携带凭据。
3. **只读默认与受控同步**：默认只读不修改 Git 跟踪文件、不执行 GitHub 写操作；可选 `--sync-local-extension <dir>` 仅在扩展 ZIP 验签通过且目标目录未被 Git 跟踪（如 gitignored 的 `frontend/dist-extension`）时原子解压同步。
4. **并行提速与三级风险分档**（详见 [`docs/RELEASE-RECEIPT.md` §3](../../docs/RELEASE-RECEIPT.md)）：
   - **`lite`（默认，约 10–15s）**：并行运行 ① 官方扩展 ZIP 安全边界验签 + 可选 HTTP 安全头/预压缩 `br`/`/llms.txt`/真 `404`/`/api/stats` 匿名 `401` 核验；② 纯网页无头 Chrome（`/` 水合 + 主题启动 + `/downloads/` 模块 SW 注册与 `/downloads/bridge.html` iframe `MessageChannel` `ping` + `/monitor` 桌面/`390×844` 零横向溢出 + `0` CSP/报错）；③ 零修改官方扩展无头 Chrome（`WEB_EXT_PING`、无「有新版」提示、零油猴全局、`0` CSP/报错）。
   - **`full`**：在 `lite` 基础上复用已验签的扩展 Chrome 实例追加线上 B 站 + 间隔 `>= 8.5s` 后的 YouTube 零油猴真实解析抽测；可选 `--with-mux-save` 进一步校验 Mediabunny 双轨落盘容器头与非 36 位 UUID 文件名。
5. **Fail-Closed 脱敏与一键出回执**：写入 `--json-out` / `--md-out` 或 stdout 前强制扫描完整 URL、IPv4/IPv6、`xsec_token`/`owner_token`/`Bearer`、`ticket=`/`sign=`/`sig=`、查询串、`/api/media/` 路径及 `/Users/`、`/home/`、`C:\Users\` 本机路径，命中即报错退出非零。

### 参数表

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--base-url <url>` | `https://snap.dokitool.com` | 目标站点源（仅允许 `https://`，回环地址允许 `http://`，禁止凭据/路径/查询串） |
| `--profile <lite\|full>` | `lite` | 验收档位（`lite` 并行轻量冒烟；`full` 追加 B 站 + YouTube 零油猴真实解析） |
| `--manifest <path>` | 无 | `release-manifest.json` 路径，用于核对扩展 ZIP 大小与 SHA-256 及关键静态文件摘要 |
| `--skip-http-checks` | 关闭 | 跳过阶段一已核验的 HTTP 响应头/预压缩/404 子项（仍保留扩展 ZIP 下载与验签） |
| `--with-mux-save` | 关闭 | 仅限 `--profile full`，触发 Mediabunny 双轨落盘并验证容器头与非 36 位 UUID 文件名 |
| `--sync-local-extension <dir>` | 无 | 验签通过后原子同步解压官方扩展至指定未跟踪目录（拒绝 Git 已跟踪路径） |
| `--samples <path>` | `scripts/prod-smoke/samples.json` | `--profile full` 默认样本清单路径 |
| `--bilibili-url <url>` / `--youtube-url <url>` | 取自 `samples.json` | 临时覆盖 `--profile full` 的 B 站 / YouTube 公开样本 URL |
| `--chrome-bin <path>` | 自动探测 | 显式指定 Chrome / Chromium 可执行文件路径（优先级高于 `DOKITOOL_CHROME_BIN`） |
| `--proxy <url>` | 读取环境代理 | 显式指定无凭据 HTTP(S) 代理（回环地址始终直连） |
| `--expected-ext-version <ver>` | 无 | 严格校验扩展 `manifest.json` 版本号 |
| `--expected-ext-files <int>` | 无 | 严格校验扩展 ZIP 内文件数 |
| `--timeout <seconds>` | `30` | 单步 HTTP / 浏览器等待超时秒数 |
| `--json-out <path>` | 无 | 输出 Fail-Closed 脱敏 JSON 报告（UTF-8） |
| `--md-out <path>` | 无 | 输出可直接 `gh issue comment` 的阶段二脱敏 Markdown 回执（UTF-8） |
| `--format <both\|md\|json\|none>` | `both` | 标准输出格式 |

### 常用命令

```bash
# 1. 标准 lite 验收并生成可直接张贴的阶段二 Markdown 回执
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile lite \
  --manifest /path/to/release-manifest.json \
  --md-out stage2-receipt.md \
  --json-out stage2-report.json

# 2. 配合阶段一已通过场景，跳过重复 HTTP 响应头子项
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile lite \
  --skip-http-checks \
  --manifest /path/to/release-manifest.json \
  --md-out stage2-receipt.md

# 3. 高风险改动（下载/合流/扩展/解析交互）执行 full 档 + Mediabunny 双轨落盘校验
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile full \
  --with-mux-save \
  --manifest /path/to/release-manifest.json \
  --sync-local-extension frontend/dist-extension \
  --md-out stage2-receipt.md

# 4. 运行离线单元测试（纯逻辑模式与含本地 loopback 无头 Chrome E2E 模式）
DOKITOOL_STAGE2_SKIP_BROWSER=1 node --test scripts/prod-smoke/test_stage2_browser.mjs
DOKITOOL_STAGE2_REQUIRE_BROWSER=1 node --test scripts/prod-smoke/test_stage2_browser.mjs
```

退出码约定：`report.passed == true`（`FAIL == 0` 且 `RESIDUAL_CHROME == 0` 且脱敏扫描 `0` 敏感项）时返回 `0`，否则返回 `1`。
