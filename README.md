# DokiTool

DokiTool 是面向多平台的公开短视频、图集与实况照片无水印解析及浏览器直连保存工具，线上站点：<https://snap.dokitool.com>。

## 支持平台（14 个）

平台目录真值位于 `backend/config/platforms.json` 与 `backend/internal/catalog/catalog.go`（部分平台按服务端启动开关启用，详见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)）。前端粘贴文本时会自动提取首个 `http(s)` 链接并剥离尾随标点。

| 平台 | 支持媒体类型 | 接受的链接形式（含短链与域名归一化） | 已知限制 |
| --- | --- | --- | --- |
| 抖音（`douyin`） | 视频 / 图片 / 实况 | `douyin.com`（`www.douyin.com`、`v.douyin.com`）、`iesdouyin.com` | 不支持合集链接（`mix_id`） |
| 快手（`kuaishou`） | 视频 / 图片 | `kuaishou.com`（`www.kuaishou.com/short-video/...`、`/f/...`、`v.kuaishou.com`、`c.kuaishou.com`） | 仅公开分享作品；触发上游页面风控时返回 `UPSTREAM_BLOCKED` |
| 哔哩哔哩（`bilibili`） | 视频 | `bilibili.com`（`www.bilibili.com`、`m.bilibili.com`）、`b23.tv` | 多 P 分集按需逐集调用 `/api/resolve`；不支持番剧、付费或大会员专享稿件 |
| 小红书（`xiaohongshu`） | 视频 / 图片 / 实况 | `xiaohongshu.com`、`xhslink.com`、`rednote.com` | 网页直链须含 `xsec_token`，缺失时需从小红书 App 复制分享链接 |
| 今日头条（`toutiao`） | 视频 | `toutiao.com`（`www.toutiao.com`、`m.toutiao.com` 的 `/video/`、`/group/`、`/i<id>`） | `*.toutiaovod.com` 上游无跨域读取头与附件下载头，通过「打开源链接」在新标签页右键「视频另存为」（手机端长按保存） |
| 微博（`weibo`） | 视频 | `weibo.com`、`www.weibo.com`、`video.weibo.com/show?fid=...`、`m.weibo.cn` | 视频经本站 `/api/media/weibo` 短期签名票据（30 分钟有效）中转，依赖服务端配置签名密钥 |
| 皮皮虾（`pipixia`） | 视频 / 图片 | `pipix.com`（`h5.pipix.com/item/...`、`/ppx/item/...`） | 仅支持公开分享帖子 |
| 皮皮搞笑（`pipigx`） | 视频 | `pipigx.com`（`h5.pipigx.com/pp/post/...`）、`ippzone.com` | 优先校验 `tbvideo.ixiaochuan.cn` 无水印 MP4 直下（不支持 ZIP 打包），失败回退手动打开源链接 |
| 最右（`zuiyou`） | 视频 / 图片 | `izuiyou.com`、`share.xiaochuankeji.cn` | 线上关闭视频 `tbvideo` 改写，视频通过「打开源链接」手动保存；图片支持直下与打包 |
| X（`x`） | 视频 / 图片 | `x.com`、`twitter.com`（含 `www.`、`mobile.`、`m.` 状态页及 `/photo/<N>`、`/video/<N>`）、`t.co`（受控单跳展开至推文页） | `t.co` 未指向有效推文页时返回 `INVALID_INPUT`；纯文本推文返回 `NO_MEDIA`；受限推文（`TweetTombstone`）需开启 `-x-tombstone-fallback=fxtwitter` 才查询公开回退源 |
| YouTube（`youtube`） | 视频 | `youtube.com`（`www.`、`m.`、`music.` 的 `/watch`、`/shorts/`、`/live/`、`/embed/`）、`youtu.be` | 桌面端需安装并启用用户脚本 `DokiTool YouTube Helper`（`1.3.2`）取址与浏览器内无损合并；手机端无脚本管理器时暂不支持 |
| Instagram（`instagram`） | 视频 / 图片 | `instagram.com`（`www.`、`m.`）、`instagr.am`（`www.`）的 `/p/`、`/reel/`、`/reels/`、`/tv/` | `instagr.am` 仅接受标准帖子/Reels/TV 短链路径；不支持 Stories（`/stories/`）及私密或需登录帖（返回 `UPSTREAM_BLOCKED`） |
| Facebook（`facebook`） | 视频 | `facebook.com`、`www.facebook.com`、`m.facebook.com`、`fb.watch` | `fb.watch` 短链需登录展开，接口直接返回 `INVALID_INPUT` 提示先在浏览器打开并复制 `facebook.com` 完整链接；受限视频返回 `UPSTREAM_BLOCKED` |
| Tumblr（`tumblr`） | 视频 | `tumblr.com`、`www.tumblr.com`、`*.tumblr.com` | 仅支持公开视频帖（单帖最多提取 4 个视频条目） |

## 架构概览

- **浏览器直下，服务端仅解析**：Go 后端负责输入校验、上游页面/接口解析与统一媒体 v1（`schema_version=1.0`）契约输出；媒体文件由用户浏览器直接连接平台 CDN 下载（通过同源 Service Worker 流式落盘、缓冲拼接或原生附件移交）。**微博视频（`/api/media/weibo`）是唯一的服务端签名媒体流中转例外**。
- **日本主解析 + 上海国内线路补充（抖音与可选哔哩哔哩）**：主后端承担全站路由与准入限流；上海 `shanghai-resolver` 通过出站 `pull` 模式（`v2` 协议）保持在线：默认认领抖音 `aweme_id` 提取国内 `*.douyinvod.com` 各档清晰度与 4K 原画候选，并在主后端显式开启 `DOKITOOL_SHANGHAI_BILIBILI`（默认关闭）时认领哔哩哔哩 `(bvid, cid)` 补充国内 `*.bilivideo.com` 播放地址，交回主后端合并后由前端并发测速择优下载；上海忙碌或超时时主后端无阻塞回退本地解析。
- **YouTube 浏览器端取址与无损合并**：桌面浏览器安装同源用户脚本 `dokitool-youtube.user.js` 后，在客户端直接向 `www.youtube.com` 请求播放清单，交由服务端无权限 Deno `ejs` 沙箱解算签名挑战；`1080p` / `4K` 等分离音视频由脚本并发拉取 `googlevideo.com` 并在浏览器内用 Mediabunny 无损封装保存。

## 目录结构

```text
.
├── backend/
│   ├── cmd/
│   │   ├── dokitool/          # 主后端 HTTP API 服务（serve）与 catalog / validate / version 子命令
│   │   ├── shanghai-resolver/ # 上海国内线路辅助解析进程（出站 pull 模式或历史 direct 模式）
│   │   └── loadtest/          # 仅限本地回环（127.0.0.1）运行的混合流量压测工具
│   ├── config/                # 内嵌平台注册目录真值（platforms.json）
│   └── internal/              # Go 内部模块（按包划分职责边界；ytengine、platform/x、platform/instagram 等大包在包内按职责拆分为多文件）
│       ├── fetch/             # 受控出站 HTTP 客户端（逐跳 DNS 校验、PublicIP 检查、IP 绑定拨号与页面 TLS 传输）
│       ├── urlpolicy/         # 跨平台复用的媒体/封面直链语法、控制字符、标准端口与域名后缀白名单校验
│       ├── bearer/            # 统一长度上限、可打印 ASCII 与 SHA-256 常量时间比对的 Bearer 请求头鉴权
│       ├── unified/           # 统一媒体 v1（schema_version=1.0）契约模型、内嵌 Schema 校验与默认画质选择
│       ├── catalog/           # 平台目录加载、查询与运行时动态启用控制
│       ├── probe/             # 有界 ISO BMFF / MP4 头部与原子元数据探测（不拉取完整媒体文件）
│       ├── ytengine/          # 受 SHA-256 锁定的 yt-dlp 提取器进程池、本地回环出站安全网关、并发槽位与契约适配
│       ├── platform/          # 各平台解析适配器（douyin、bilibili、weibo、xiaohongshu、kuaishou、toutiao、pipixia、pipigx、zuiyou、x、youtube、instagram 及通用长尾包 ytgeneric）
│       ├── media/             # 特殊媒体交付协议（media/weibo 短期签名票据与流式中转、media/tbvideo 同路径无水印候选构造）
│       ├── shresolver/        # 上海通道任务分发 Broker、出站 pull 工作协程与跨地域统计
│       └── api/               # HTTP 路由分发、多池准入与排队限流、短时解析缓存（singleflight + LRU）及 /api/stats 统计
├── frontend/                  # Vue 3 + Vite 单页应用、同源 Service Worker 流式下载器与 YouTube 浏览器助手用户脚本
├── ops/                       # Caddy 反向代理配置示例与生产发布/回滚脚本（ops/release/）
├── scripts/                   # OpenAPI/JSON Schema 校验、公开文件清单门禁、Go 迁移对拍（go-migration/）与冒烟测试脚本
├── docs/                      # 接口契约、配置参考、下载机制、部署回滚与历史归档文档
└── examples/                  # 仅依赖 Python 标准库的个人 Agent 批量直连下载参考脚本
```

## 准入与限流

服务端按可信客户端 IPv4 或 IPv6 `/64` 前缀隔离匿名预算，并将 API 请求分发至 5 个核心准入池（另为微博媒体流中转 `DOKITOOL_WEIBO_` 与下载结果上报 `DOKITOOL_REPORT_` 保留专用辅助池；全部环境变量说明见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)）：

| 准入池 | 环境变量前缀 | 覆盖请求范围与分流规则 |
| --- | --- | --- |
| `fast` | `DOKITOOL_PARSE_` | 未命中缓存的纯 Go 国内平台 `GET /api/parse` 请求及已退役旧路径，含单客户端/全局令牌桶、并发上限与有界 FIFO 等待队列 |
| `resolve` | `DOKITOOL_RESOLVE_` | 未命中缓存的纯 Go 平台按需分集解析 `GET /api/resolve`（如哔哩哔哩多 P 选集），提供独立更宽的单 IP 突发与并发配额，避免挤占首次解析配额 |
| `slow` | `DOKITOOL_PARSE_SLOW_` | 未命中缓存的海外慢解析平台（`x`、`youtube`、`instagram`、`facebook`、`tumblr`）`/api/parse` 与 `/api/resolve`，以及未命中缓存的 `GET /api/youtube/context` 和 `POST /api/youtube/finalize` |
| `catalog` | `DOKITOOL_CATALOG_` | `GET /api/platforms`、命中缓存的 `GET /api/youtube/context`，以及**命中进程内新鲜缓存（`DOKITOOL_PARSE_CACHE`）的 `GET /api/parse` 与 `GET /api/resolve` 请求**（零上游开销，不消耗解析池配额） |
| `owner` | `DOKITOOL_OWNER_*` | 携带有效 `Authorization: Bearer $DOKITOOL_OWNER_TOKEN` 的个人 Agent 通道请求（与匿名池完全隔离；无效鉴权头绝不降级为匿名请求，而是扣减调用方 IP 在 `fast` 池的防刷配额并返回 `401` / `429`） |

## 安全边界

- **无状态零 Cookie 出站与逐跳目标白名单**：服务端解析请求不携带任何用户或平台账号 Cookie；所有出站请求按平台白名单限制域名、协议与标准端口，并在逐跳重定向与 DNS 解析时拦截回环、私网、链路本地与云元数据地址。`yt-dlp` 子进程经本地回环任务网关强制执行同一出站域名白名单。
- **浏览器直链语法白名单与服务端出站 DNS/IP 绑定分层**：返回给浏览器直连下载的媒体与封面直链仅执行纯本地 URL 语法及平台域名白名单校验（服务端不对其发起 DNS 查询）；而所有由服务端主动发起的出站请求（含页面/接口抓取、媒体头部探测、微博流中转及 `yt-dlp` 回环网关转发）均经 `fetch.Client` 执行逐跳 DNS 解析、公网 IP 校验（`fetch.PublicIP`）与已验证 IP 绑定拨号。
- **服务端不中转媒体**：除微博视频使用短期 HMAC-SHA256 签名票据（严格校验 `*.weibocdn.com` / `*.miaopai.com` 与上游响应类型）外，服务端不代理或落盘任何平台音视频与图片字节。
- **用户脚本最小权限**：`frontend/public/helper/dokitool-youtube.user.js` 仅响应固定页面事件，`@connect` 严格限定 `www.youtube.com` 与 `googlevideo.com`（覆盖 `*.googlevideo.com` 媒体子域），且全部跨域请求强制设置 `anonymous: true`（不附带浏览器 Cookie）。
- **唯一第三方解析回退依赖**：仅当启动参数显式设为 `-x-tombstone-fallback=fxtwitter` 且 X 官方 Syndication 接口返回 `TweetTombstone` 时，服务端才向公开接口 `api.fxtwitter.com` 查询推文元数据，且媒体域名仍强制限制为 `pbs.twimg.com` 与 `video.twimg.com`。

## 本地开发与测试

环境要求：**Go `1.27.3`**（见 `backend/go.mod`）、**Node.js `20+`**。

```bash
# 1. 前端依赖安装、单测与生产构建
cd frontend
npm ci
npm test
npm run build

# 2. 后端全量离线契约与单元测试
cd ../backend
go test ./...

# 3. 本地启动 Go API 服务（默认同源路由，可配合 Vite 开发代理联调）
go run ./cmd/dokitool serve
```

## 已退役的 PHP 对拍代码

仓库内原地保留以下历史 PHP 代码、导出脚本与配置示例：

- `backend/api/`、`backend/lib/`、`backend/public/index.php`、`backend/internal/index.php`、`backend/bin/catalog.php`
- `backend/tests/*.php`、`scripts/go-migration/produce*.php`
- 历史 PHP-FPM 配置示例：`ops/examples/snap-fpm.conf`

上述文件均**已退役，完全不参与线上生产运行**（生产环境不部署 PHP / PHP-FPM，所有流量由 Go 二进制独立承载），原地保留仅用作 Go 实现的冻结行为对拍基准（Oracle），供 `.github/workflows/go-migration.yml` 中的 `bilibili-php-oracle` CI 任务以及离线门禁脚本 `scripts/go-migration/check.py --check-php-source` 重放和核对固定版本源码摘要使用。**禁止在这些 PHP 文件中新增功能，仅允许为维持既有对拍能力所必需的修正。**

## 文档索引

- [docs/API.md](docs/API.md)：统一媒体 v1 接口契约、错误码（含 `UNSUPPORTED_PLATFORM`、`UPSTREAM_BLOCKED`、`NO_MEDIA`、`429` 退避）与 YouTube Helper 接口
- [docs/AGENT-API.md](docs/AGENT-API.md)：面向个人脚本与自动化 Agent 的私有通道认证、接口参考、错误码处置及并发/缓存说明
- [docs/AGENT-BATCH-DOWNLOAD.md](docs/AGENT-BATCH-DOWNLOAD.md)：Agent 批量下载流水线、多线路切换、断点续传最佳实践与零依赖示例脚本说明
- [docs/openapi.json](docs/openapi.json)：统一媒体 v1 与个人 Agent 通道的 OpenAPI `3.1.0` 规范文件
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)：`dokitool` 与 `shanghai-resolver` 全部命令行启动参数及环境变量说明
- [docs/DOWNLOADS.md](docs/DOWNLOADS.md)：浏览器流式下载、多线路测速、ZIP 打包上限、调试开关与应用内置浏览器提示说明
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)：生产发布流程（发布 Issue → 干净构建 → 清单核验 → systemd drop-in 与软链原子切换 → 冒烟与复测）
- [docs/go-migration/rollback.md](docs/go-migration/rollback.md)：生产回滚操作流程与核验门禁
- [docs/go-migration/douyin-shanghai.md](docs/go-migration/douyin-shanghai.md)：抖音上海 `pull` 模式（`v2` 协议、3 worker、超时预算、回退与自动重启）设计说明
- [docs/schema/unified-v1/README.md](docs/schema/unified-v1/README.md)：统一媒体 v1 JSON Schema 定义与校验命令
- [docs/HISTORY.md](docs/HISTORY.md)：PHP 时期架构、Go 迁移历程与早期验收归档

## 许可证与上游致谢

本仓库原创与衍生代码采用 [MIT License](LICENSE)，完整第三方组件与许可证声明见 [NOTICE](NOTICE)：

- **早期架构与解析参考**：[jiuhunwl/short_videos](https://github.com/jiuhunwl/short_videos)（MIT）与 [jiuhunwl/shortvideo-html](https://github.com/jiuhunwl/shortvideo-html)（MIT）— 详见 [NOTICE](NOTICE) 与 [docs/HISTORY.md](docs/HISTORY.md)。
- **Mediabunny**（`1.65.2`，`MPL-2.0`，Vanilagy）：内嵌于公开用户脚本 `frontend/public/helper/dokitool-youtube.user.js`，用于在浏览器端对 YouTube 分离视频轨与音轨执行无损 MP4/WebM 封装合并；文件级源码获取说明保留在用户脚本头部与 [NOTICE](NOTICE)。
- **FixTweet**（`api.fxtwitter.com`）：在服务端显式启用 `-x-tombstone-fallback=fxtwitter` 时，作为 X 受限推文（`TweetTombstone`）的可选公开 HTTP 元数据查询源；本仓库未复制或分发 FixTweet 源代码（详见 [NOTICE](NOTICE)）。
