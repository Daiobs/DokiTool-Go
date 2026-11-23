# 启动参数与环境变量参考

本文档列出 `dokitool` 主服务、`shanghai-resolver` 辅助进程以及前端构建链支持的全部命令行参数与环境变量。

> **说明**：为遵循公开仓库安全规范并避免文档与代码漂移，本文档**不记录任何线上生产密钥或部署实例的私有覆盖取值**；环境变量表格记录参数名称、作用与敏感属性，多密钥鉴权注册表（`DOKITOOL_API_KEYS_FILE`）的结构约束、角色默认值与边界定义见文末第五节。

---

## 一、`dokitool` 子命令与启动参数

源码定义：`backend/cmd/dokitool/main.go`

### 1. 子命令

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `serve` | 启动主后端 HTTP API 解析、内部控制面与准入限流服务（支持 `SIGHUP` 原子热重载 Bearer 鉴权密钥表） | 否 |
| `hash-token` | 从标准输入读取单条原始令牌（严禁通过命令行位置参数传递），校验长度与可打印 ASCII 合法性后向标准输出打印 64 位小写 SHA-256 十六进制摘要 | 是（标准输入含敏感凭据） |
| `catalog` | 向标准输出打印当前内置平台目录的统一契约 JSON | 否 |
| `validate` | 从标准输入读取 JSON 载荷并按统一媒体契约结构执行校验 | 否 |
| `version` | 向标准输出打印编译阶段注入的程序版本标识 | 否 |

### 2. `dokitool serve` 命令行参数

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `-listen` | 指定主后端本地回环 HTTP 监听地址与端口 | 否 |
| `-xhs-page-transport` | 选择小红书分享页与笔记页的 HTTPS 抓取传输实现（标准库传输或指定浏览器 TLS 指纹传输） | 否 |
| `-x-tombstone-fallback` | 控制 X 受限推文（墓碑页）的回退行为（直接返回受限错误，或向公开第三方元数据接口查询） | 否 |
| `-client-identity` | 指定准入控制识别客户端地址的方式（仅接受本地回环直连对端，或校验前置反向代理转发的身份头） | 否 |

---

## 二、`shanghai-resolver` 启动参数

源码定义：`backend/cmd/shanghai-resolver/main.go`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `-pull-origin` | 出站拉取模式下连接主后端领取抖音任务与回传结果的 HTTPS 源站地址（与入站监听类参数互斥） | 否 |
| `-workers` | 出站拉取模式下并发运行的抖音任务认领与原画探测工作协程数量（仅在指定 `-pull-origin` 时生效） | 否 |
| `-listen` | 历史入站直连模式下的本地监听地址与端口 | 否 |
| `-tls-cert` | 历史入站直连 HTTPS 模式下的服务端证书链文件路径 | 否 |
| `-tls-key` | 历史入站直连 HTTPS 模式下的服务端私钥文件路径 | 是 |

---

## 三、后端环境变量

### 1. 密钥与鉴权凭据

源码定义：`backend/cmd/dokitool/main.go`、`backend/cmd/shanghai-resolver/main.go`、`backend/internal/bearer/bearer.go`、`backend/internal/api/apikeys.go`、`backend/internal/api/admission.go`、`backend/internal/api/admission_config.go`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `SNAP_MEDIA_SIGNING_KEY` | 微博视频同源中转接口签发与校验短期访问票据所用的共享 HMAC 密钥 | 是 |
| `SNAP_INGRESS_KEY` | 前置反向代理转发客户端真实地址时用于认证边缘请求头的共享密钥 | 是 |
| `DOKITOOL_SHANGHAI_PULL_TOKEN` | 上海拉取模式下任务认领与结果回传内部路由专用的独立 Bearer 鉴权令牌（不得与其他密钥相同） | 是 |
| `DOKITOOL_SHANGHAI_TOKEN` | 历史上海入站直连模式下的请求 Bearer 鉴权令牌 | 是 |
| `DOKITOOL_OWNER_TOKEN` | 个人 `owner` 通道及只读统计接口（`/api/stats`）的私有 Bearer 鉴权令牌（非空时生成隐式 `id: "owner"`、`role: "owner"` 密钥，可与 `DOKITOOL_API_KEYS_FILE` 并存；须为独立凭据且不得与其他密钥或摘要冲突） | 是 |
| `DOKITOOL_API_KEYS_FILE` | 指定多密钥 SHA-256 鉴权注册表 JSON 配置文件路径（支持 `owner` / `agent` / `friend` 角色、按密钥独立并发池与速率限流、平台白名单及 `SIGHUP` 原子热重载；文件内仅存 SHA-256 摘要，建议宿主机权限设为 `0600`） | 是（含鉴权摘要与策略） |

### 2. 抖音上海通道、解析缓存、统计快照与平台启用开关

源码定义：`backend/cmd/dokitool/main.go`、`backend/cmd/shanghai-resolver/main.go`、`backend/internal/api/cache.go`、`backend/internal/api/stats_persistence.go`、`backend/internal/platform/ytgeneric/sites.go`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `DOKITOOL_SHANGHAI_MODE` | 控制主后端上海解析通道的工作模式（禁用、历史直连模式或出站拉取模式） | 否 |
| `DOKITOOL_SHANGHAI_ENDPOINT` | 历史上海直连模式下主后端请求的远端解析端点地址（拉取模式下必须留空） | 否 |
| `DOKITOOL_SHANGHAI_BILIBILI` | 控制主后端在启用上海解析通道时是否开启哔哩哔哩国内线路并行解析与合并 | 否 |
| `DOKITOOL_BILIBILI_DASH` | 控制 `dokitool` 主后端与 `shanghai-resolver` 上海节点是否开启哔哩哔哩免登录 DASH（1080P 视频轨与独立 M4A 音频轨）并行解析与合并；默认关闭（`false`），关闭时两端均严格仅发送原有单次 `durl` 请求，传入非布尔值时进程在监听前即报错退出 | 否 |
| `DOKITOOL_PARSE_CACHE` | 控制主后端是否启用 `/api/parse` 与 `/api/resolve` 进程内短时结果缓存及同键并发请求合并 | 否 |
| `DOKITOOL_STATS_SNAPSHOT_PATH` | 指定 `/api/stats` 统计快照的本地持久化文件路径（默认为空，纯内存运行不执行磁盘读写）；配置路径后，启动时加载未过期的近 30 天（`Asia/Shanghai` UTC+8）日桶与近 24 小时时桶，文件不存在则冷启动，若文件损坏或快照版本不匹配则打印告警并以安全空状态启动、不阻塞主服务；运行期每 5 分钟及收到 `SIGINT`/`SIGTERM` 停机时通过同目录临时文件 + `Sync` + 原子重命名以 `0600` 权限落盘；仅存聚合统计元数据，绝不写入 URL、IP 或令牌 | 否 |
| `DOKITOOL_TBVIDEO_REWRITE_PIPIGX` | 控制是否为皮皮搞笑视频生成同路径跨域可读无水印候选附件信息 | 否 |
| `DOKITOOL_TBVIDEO_REWRITE_ZUIYOU` | 控制是否为最右视频生成同路径跨域可读无水印候选附件信息 | 否 |
| `DOKITOOL_YTDLP_X_ENABLED` | 控制是否注册并启用 X 平台解析适配器（启用时在启动阶段强校验提取器可用性） | 否 |
| `DOKITOOL_YTDLP_YOUTUBE_ENABLED` | 控制是否注册并启用 YouTube 解析路由适配器（启用时在启动阶段强校验提取器可用性） | 否 |
| `DOKITOOL_YTDLP_INSTAGRAM_ENABLED` | 控制是否注册并启用 Instagram 平台解析适配器（启用时在启动阶段强校验提取器可用性） | 否 |
| `DOKITOOL_YTDLP_SITES` | 按逗号分隔指定启用的长尾海外平台标识集合（含未知标识或空项时拒绝启动；已退役标识静默忽略） | 否 |
| `DOKITOOL_YTDLP_GENERIC_ENABLED` | 控制是否开启两级路由的第二级通用具名提取器兜底（仅响应 `GET /api/parse` 且 `platform=all` 或省略的非目录公网链接，严格禁用 `generic` 盲抓提取器；默认关闭 `false`，启用时强校验外部提取器可用性，传入非布尔值时拒绝启动） | 否 |
| `DOKITOOL_YOUTUBE_HELPER` | 控制是否启用 YouTube 浏览器助手上下文与签名结算接口（启用时在启动阶段校验运行时与脚本文件摘要） | 否 |

> **`DOKITOOL_BILIBILI_DASH` 灰度启用与回滚说明**：
> - **默认安全态（`false` 或未设置）**：`dokitool` 与 `shanghai-resolver` 均严格只发原有的单次 `html5 durl` 请求（零额外 `fnval=4048&try_look=1` 上游请求）；即使上海节点已先开启 `DOKITOOL_BILIBILI_DASH=true`，只要主后端仍为 `false`，主后端会自动忽略上海回传的 DASH 轨道、仅保留原有 `durl` 线路。
> - **灰度开启顺序**：若已启用 `DOKITOOL_SHANGHAI_BILIBILI=true`，可先在 `shanghai-resolver`（支持拉取模式与历史直连模式）或同步在 `dokitool` 与 `shanghai-resolver` 中设置 `DOKITOOL_BILIBILI_DASH=true` 并重启；仅部署单机主后端时只需在 `dokitool` 设置 `DOKITOOL_BILIBILI_DASH=true` 即可。当 `durl` 正常返回而并行 DASH 请求超时，系统会在短宽限窗口（主后端 `2.5s`、上海节点 `1.2s`）后自动取消慢速 DASH 请求并零报错回退至 `720P durl`。
> - **快速回滚**：将 `DOKITOOL_BILIBILI_DASH` 置为 `false`（或移除该环境变量）并重启对应进程即可立即恢复单次 `durl` 请求模式，无需回退代码版本。

### 3. 外部提取器、任务网关与签名解算沙箱

源码定义：`backend/internal/ytengine/engine.go`、`backend/internal/ytengine/gate_ports.go`、`backend/internal/platform/youtube/ejs_sandbox.go`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `DOKITOOL_YTDLP_BINARY` | 指定受官方发布摘要锁定校验的外部提取器可执行文件路径 | 否 |
| `DOKITOOL_YTDLP_CONCURRENCY` | 指定核心海外提取器平台共享的最大并发子进程数 | 否 |
| `DOKITOOL_YTDLP_GENERIC_CONCURRENCY` | 指定第二级通用具名提取器兜底独立隔离的最大并发子进程数（整数 `1..24`，默认 `2`；与核心慢解析池及核心 `yt-dlp` 槽位严格隔离，非法或越界值在启动阶段即拒绝运行） | 否 |
| `DOKITOOL_YTDLP_TIMEOUT` | 指定单次外部提取器子进程调用的超时时长 | 否 |
| `DOKITOOL_YTDLP_GATE_PORTS` | 按逗号分隔指定本地回环任务网关监听端口池（端口数量须与提取器并发上限一致） | 否 |
| `DOKITOOL_YTDLP_PROXY` | 外部提取器代理配置项（启用出站目标白名单策略时禁止设置；若携带代理凭据则属敏感信息） | 是 |
| `DOKITOOL_DENO_BINARY` | 指定用于无权限沙箱解算 YouTube 签名挑战且受摘要校验的 Deno 可执行文件路径 | 否 |
| `DOKITOOL_EJS_DIR` | 指定存放受摘要校验的 YouTube 签名解算脚本文件的目录路径 | 否 |
| `DOKITOOL_EJS_CONCURRENCY` | 指定 Deno 签名解算沙箱允许的最大并发子进程数 | 否 |
| `DOKITOOL_EJS_TIMEOUT` | 指定单次 Deno 签名解算子进程执行的超时时长 | 否 |
| `PATH` | 系统可执行文件搜索路径，用于定位提取器或启动自检所需的运行时 | 否 |
| `SYSTEMROOT` | Windows 环境下向净化后的提取器子进程透传的系统根目录路径 | 否 |

### 4. 准入控制限流与并发池

源码定义：`backend/internal/api/admission_config.go`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `DOKITOOL_ADMISSION_MAX_CLIENTS` | 指定每个准入限流池内跟踪的独立客户端状态表容量上限 | 否 |
| `DOKITOOL_PARSE_CLIENT_BURST` | 快解析池（覆盖未命中缓存的纯 Go 国内平台 `/api/parse` 请求及历史兼容路由）单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_CLIENT_RPS` | 快解析池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_CLIENT_CONCURRENCY` | 快解析池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_PARSE_GLOBAL_BURST` | 快解析池全局令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_GLOBAL_RPS` | 快解析池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_GLOBAL_CONCURRENCY` | 快解析池全局允许同时在途的最大请求数 | 否 |
| `DOKITOOL_PARSE_QUEUE_WAIT` | 快解析池在全局并发满载时允许请求进入 FIFO 队列等待的最长时长 | 否 |
| `DOKITOOL_PARSE_QUEUE_SIZE` | 快解析池 FIFO 等待队列的最大容量上限 | 否 |
| `DOKITOOL_RESOLVE_CLIENT_BURST` | 按需单集解析池（覆盖未命中缓存的纯 Go 国内平台 `/api/resolve` 请求，避免多 P 分集按需拉取挤占首次解析配额）单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_RESOLVE_CLIENT_RPS` | 按需单集解析池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_RESOLVE_CLIENT_CONCURRENCY` | 按需单集解析池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_RESOLVE_GLOBAL_BURST` | 按需单集解析池全局令牌桶突发容量 | 否 |
| `DOKITOOL_RESOLVE_GLOBAL_RPS` | 按需单集解析池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_RESOLVE_GLOBAL_CONCURRENCY` | 按需单集解析池全局允许同时在途的最大请求数 | 否 |
| `DOKITOOL_RESOLVE_QUEUE_WAIT` | 按需单集解析池在全局并发满载时允许请求进入 FIFO 队列等待的最长时长 | 否 |
| `DOKITOOL_RESOLVE_QUEUE_SIZE` | 按需单集解析池 FIFO 等待队列的最大容量上限 | 否 |
| `DOKITOOL_PARSE_SLOW_CLIENT_BURST` | 慢解析池（覆盖未命中缓存的海外提取器平台 `/api/parse`、`/api/resolve` 及 YouTube 助手接口）单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_SLOW_CLIENT_RPS` | 慢解析池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_SLOW_CLIENT_CONCURRENCY` | 慢解析池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_PARSE_SLOW_GLOBAL_BURST` | 慢解析池全局令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_SLOW_GLOBAL_RPS` | 慢解析池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_SLOW_GLOBAL_CONCURRENCY` | 慢解析池全局允许同时在途的最大请求数（未显式设置时跟随 `DOKITOOL_YTDLP_CONCURRENCY`） | 否 |
| `DOKITOOL_PARSE_SLOW_QUEUE_WAIT` | 慢解析池在全局并发满载时允许请求进入 FIFO 队列等待的最长时长 | 否 |
| `DOKITOOL_PARSE_SLOW_QUEUE_SIZE` | 慢解析池 FIFO 等待队列的最大容量上限 | 否 |
| `DOKITOOL_PARSE_GENERIC_CLIENT_BURST` | 独立通用长尾慢解析池（覆盖未命中缓存的第二级通用具名提取器 `/api/parse` 请求，与快解析池及核心慢解析池完全隔离）单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_GENERIC_CLIENT_RPS` | 独立通用长尾慢解析池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_GENERIC_CLIENT_CONCURRENCY` | 独立通用长尾慢解析池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_PARSE_GENERIC_GLOBAL_BURST` | 独立通用长尾慢解析池全局令牌桶突发容量 | 否 |
| `DOKITOOL_PARSE_GENERIC_GLOBAL_RPS` | 独立通用长尾慢解析池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_PARSE_GENERIC_GLOBAL_CONCURRENCY` | 独立通用长尾慢解析池全局允许同时在途的最大请求数（未显式设置时跟随 `DOKITOOL_YTDLP_GENERIC_CONCURRENCY`） | 否 |
| `DOKITOOL_PARSE_GENERIC_QUEUE_WAIT` | 独立通用长尾慢解析池在全局并发满载时允许请求进入 FIFO 队列等待的最长时长 | 否 |
| `DOKITOOL_PARSE_GENERIC_QUEUE_SIZE` | 独立通用长尾慢解析池 FIFO 等待队列的最大容量上限 | 否 |
| `DOKITOOL_OWNER_CONCURRENCY` | 隐式 `DOKITOOL_OWNER_TOKEN` 通道及未显式指定 `concurrency` 的 `owner` 角色密钥允许同时在途的最大并发请求数 | 否 |
| `DOKITOOL_OWNER_QUEUE_WAIT` | 隐式 `DOKITOOL_OWNER_TOKEN` 通道及未显式指定 `queue_wait` 的 `owner` 角色密钥在并发满载时允许进入 FIFO 队列等待的最长时长 | 否 |
| `DOKITOOL_OWNER_QUEUE_SIZE` | 隐式 `DOKITOOL_OWNER_TOKEN` 通道及未显式指定 `queue_size` 的 `owner` 角色密钥 FIFO 等待队列的最大容量上限 | 否 |
| `DOKITOOL_CATALOG_CLIENT_BURST` | 匿名目录池（覆盖匿名平台目录、匿名命中进程内新鲜缓存的 `/api/parse` 与 `/api/resolve` 请求，以及匿名命中缓存的 YouTube 上下文接口；已鉴权 Bearer 请求走各自密钥的零槽位快读速率桶）单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_CATALOG_CLIENT_RPS` | 目录池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_CATALOG_CLIENT_CONCURRENCY` | 目录池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_CATALOG_GLOBAL_BURST` | 目录池全局令牌桶突发容量 | 否 |
| `DOKITOOL_CATALOG_GLOBAL_RPS` | 目录池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_CATALOG_GLOBAL_CONCURRENCY` | 目录池全局允许同时在途的最大请求数 | 否 |
| `DOKITOOL_WEIBO_CLIENT_BURST` | 微博媒体中转池单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_WEIBO_CLIENT_RPS` | 微博媒体中转池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_WEIBO_CLIENT_CONCURRENCY` | 微博媒体中转池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_WEIBO_GLOBAL_BURST` | 微博媒体中转池全局令牌桶突发容量 | 否 |
| `DOKITOOL_WEIBO_GLOBAL_RPS` | 微博媒体中转池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_WEIBO_GLOBAL_CONCURRENCY` | 微博媒体中转池全局允许同时在途的最大请求数 | 否 |
| `DOKITOOL_REPORT_CLIENT_BURST` | 下载校验上报池单客户端令牌桶突发容量 | 否 |
| `DOKITOOL_REPORT_CLIENT_RPS` | 下载校验上报池单客户端每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_REPORT_CLIENT_CONCURRENCY` | 下载校验上报池单客户端允许同时在途的最大请求数 | 否 |
| `DOKITOOL_REPORT_GLOBAL_BURST` | 下载校验上报池全局令牌桶突发容量 | 否 |
| `DOKITOOL_REPORT_GLOBAL_RPS` | 下载校验上报池全局每秒补充的请求令牌速率 | 否 |
| `DOKITOOL_REPORT_GLOBAL_CONCURRENCY` | 下载校验上报池全局允许同时在途的最大请求数 | 否 |

---

## 四、前端构建与开发期环境变量

源码定义：`frontend/src/services/apiConfig.ts`、`frontend/vite.config.js`

| 名称 | 作用 | 是否敏感 |
| --- | --- | --- |
| `VITE_API_MODE` | 前端构建期选择接口路由模式（同源兼容路由模式或独立跨域安全路由模式） | 否 |
| `VITE_API_BASE_URL` | 前端构建期指定后端 API 基础源站地址（同源部署时留空） | 否 |
| `DEV_API_TARGET` | 本地前端开发服务器将同源接口请求代理转发至本地后端实例的目标源站地址 | 否 |

---

## 五、多密钥鉴权配置文件（`DOKITOOL_API_KEYS_FILE`）与热重载

源码定义：`backend/internal/api/apikeys.go`、`backend/internal/bearer/bearer.go`、`backend/cmd/dokitool/main.go`  
脱敏配置模板：[ops/examples/api-keys.example.json](../ops/examples/api-keys.example.json)

### 1. 文件权限与离线摘要生成（`dokitool hash-token`）

- **文件大小与权限建议**：配置文件体积上限为 **`64 KiB`**（`MaxAPIKeysFileBytes = 65536`）。虽然文件内仅保存 SHA-256 摘要（严禁写入明文 `"token"` 字段，解码器开启 `DisallowUnknownFields` 会直接拒绝未知字段与尾随内容），仍建议将宿主机上的配置文件权限设置为 **`0600`**（仅 `dokitool` 服务运行账户可读），将原始明文令牌仅交由使用方自行保管。
- **离线计算 `token_sha256`**：原始 Bearer 令牌须为 `32..512` 字节可打印非空白 ASCII 字符串（字节值 `33..126`）。使用内置子命令通过**标准输入**计算 64 位小写十六进制 SHA-256 摘要（传入任何命令行位置参数均会被拒绝报错，防止令牌泄露至进程参数表）：
  ```sh
  printf '%s' "$TOKEN" | ./dokitool hash-token
  ```
- **摘要唯一性与独立凭据强校验**：拒绝全零摘要与空字符串 SHA-256 摘要；所有密钥（含 `enabled: false` 的停用条目以及非空 `DOKITOOL_OWNER_TOKEN` 生成的隐式 `"owner"` 密钥）的 `token_sha256` 必须互不相同，且不得与非空的 `SNAP_INGRESS_KEY`、`SNAP_MEDIA_SIGNING_KEY`、`DOKITOOL_SHANGHAI_TOKEN`、`DOKITOOL_SHANGHAI_PULL_TOKEN` 的 SHA-256 摘要相同。运行时请求鉴权会对全部已配置密钥摘要执行无提前退出的常量时间扫描（`subtle.ConstantTimeCompare`）。

### 2. JSON Schema 与 `DOKITOOL_OWNER_TOKEN` 并存规则

```json
{
  "keys": [
    {
      "id": "agent-bot",
      "role": "agent",
      "enabled": true,
      "token_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "concurrency": 4,
      "slow_concurrency": 1,
      "rps": 5.0,
      "burst": 16,
      "queue_size": 128,
      "queue_wait": "45s"
    },
    {
      "id": "friend-demo",
      "role": "friend",
      "enabled": true,
      "token_sha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "concurrency": 2,
      "slow_concurrency": 1,
      "rps": 1.0,
      "burst": 6,
      "queue_size": 16,
      "queue_wait": "15s",
      "platforms": ["douyin", "bilibili", "xiaohongshu"]
    }
  ]
}
```

- **并存与总容量上限（`MaxAPIKeys = 64`）**：
  - 当 `DOKITOOL_OWNER_TOKEN` 非空时，自动创建隐式密钥 `id: "owner"`（`role: "owner"`、`enabled: true`，并发与队列参数继承 `DOKITOOL_OWNER_CONCURRENCY` / `DOKITOOL_OWNER_QUEUE_SIZE` / `DOKITOOL_OWNER_QUEUE_WAIT`，`slow_concurrency: 0`、`rps: 0`、`burst: 0`）。
  - `DOKITOOL_OWNER_TOKEN` 与 `DOKITOOL_API_KEYS_FILE` 可同时启用；隐式 `"owner"` 密钥与文件内密钥总数上限为 **`MaxAPIKeys = 64`**（同时启用时文件内不得再重复定义 `id: "owner"`）。
- **核心字段语义**：
  - `id`（必填）：匹配正则 `^[a-z0-9][a-z0-9_-]{0,31}$`，注册表内唯一；该标识会出现在 `/api/stats` 的 `data.api_keys[*].id` 中（绝不暴露令牌或摘要）。
  - `role`（必填）：闭合枚举 `"owner"` | `"agent"` | `"friend"`：
    - `"owner"`：允许访问只读运行统计 `GET /api/stats` 以及允许范围内的全部解析、目录与助手接口；
    - `"agent"` / `"friend"`：允许访问允许平台范围内的 `/api/parse`、`/api/resolve`、`/api/platforms` 及 YouTube 助手接口；访问 `GET /api/stats` 会被直接拒绝并返回 HTTP `401`（`code: "INVALID_INPUT"`，`retryable: false`，计入该密钥自身的 `unauthorized` 计数，不扣减匿名单 IP 桶）。
    - 所有通过鉴权的角色（`owner`、`agent`、`friend`）在解析公开微博视频时均走直链分支（不签发 `/api/media/weibo` 服务端中转票据）。
  - `enabled`（可选布尔值，省略时默认 `true`）：设为 `false` 时立即停用该密钥的鉴权能力（携带已停用密钥的请求按无效凭据返回 HTTP `401` 并扣减匿名单 IP 突发桶），但该密钥条目仍以 `enabled: false` 展示在 `/api/stats` 的 `data.api_keys` 中。
  - `slow_concurrency`（可选整数）：慢解析子并发上限（覆盖依赖外部提取器的海外慢解析平台、第二级通用具名提取器兜底以及未命中缓存的 YouTube 助手接口），必须满足 `0 <= slow_concurrency <= concurrency`（`0` 表示不单独设子上限，共享 `concurrency`）。队列唤醒采用非队头阻塞（non-HOL-blocking）机制：当慢解析子并发满载而总并发仍有空余时，排在后面的国内纯 Go 快解析请求可直接越过等待中的慢解析请求立即获槽执行。
  - `platforms`（可选字符串数组）：按密钥限制允许访问的平台白名单。省略或空数组表示允许全部已启用平台（含已开启的第二级通用具名提取器兜底）；非空时每个元素须属于 14 个内置平台 ID（`douyin`、`bilibili`、`weibo`、`toutiao`、`kuaishou`、`pipixia`、`pipigx`、`zuiyou`、`xiaohongshu`、`x`、`youtube`、`instagram`、`facebook`、`tumblr`）或内部通用兜底作用域标识 `"ytdlp_generic"`，禁止重复或未知平台名。未包含 `"ytdlp_generic"` 的非空白名单密钥会拒绝第二级通用兜底请求；请求未授权平台或作用域时（无论缓存命中与否）一律返回 HTTP `401`（`code: "INVALID_INPUT"`，`retryable: false`）。`"ytdlp_generic"` 仅用于内部路由与鉴权范围，绝不会出现在 `/api/platforms` 或响应的 `data.platform` 中。

### 3. 角色默认值与参数合法范围

省略可选配额字段时，按 `role` 自动套用以下默认值与边界校验：

| 角色（`role`） | `concurrency`（默认 / 范围） | `slow_concurrency`（默认 / 范围） | `rps`（默认 / 范围） | `burst`（默认 / 范围） | `queue_size`（默认 / 范围） | `queue_wait`（默认 / 范围） |
| --- | --- | --- | --- | --- | --- | --- |
| `owner` | `DOKITOOL_OWNER_CONCURRENCY`（`8`） / `1..32` | `0`（不单限） / `0..24`（且 `<= concurrency`） | `0`（不限速） / `0` 或 `>0..1000` | `0` / `rps==0` 时须为 `0`，`rps>0` 时 `1..1000` | `DOKITOOL_OWNER_QUEUE_SIZE`（`256`） / `0..4096` | `DOKITOOL_OWNER_QUEUE_WAIT`（`60s`） / `0s..120s` |
| `agent` | `4` / `1..32` | `1` / `0..24`（且 `<= concurrency`） | `5.0` / `>0..1000` | `16` / `1..1000` | `128` / `0..4096` | `45s` / `0s..120s` |
| `friend` | `2` / `1..16` | `1` / `0..16`（且 `<= concurrency`） | `1.0` / `>0..100` | `6` / `1..200` | `16` / `0..512` | `15s` / `0s..60s` |

- **鉴权后零槽位快读速率桶**：对于命中进程内新鲜缓存的 `GET /api/parse` 与 `GET /api/resolve` 请求、`GET /api/platforms` 请求以及命中缓存的 `GET /api/youtube/context` 请求，通过鉴权与平台校验后直接返回响应，**占用 `0` 个密钥并发槽位**；当密钥配置了 `rps > 0` 时，此类请求使用独立的快读令牌桶（速率 `max(rps * 4, 20.0)`、突发容量 `max(burst * 4, 64)`；`rps == 0` 时不限速）。

### 4. `SIGHUP` 原子热重载

- 运行中的 `dokitool serve` 进程注册了 `SIGHUP` 信号处理器：执行 `kill -HUP <MainPID>`（或在 systemd 服务配置中加入 `ExecReload=/bin/kill -HUP $MAINPID` 后执行 `systemctl reload dokitool-go`），即可在不中断在途请求的前提下重新读取并校验 `DOKITOOL_OWNER_TOKEN` 与 `DOKITOOL_API_KEYS_FILE`。
- **无损切换与失败回退保护**：
  - 校验通过时，通过原子指针（`atomic.Pointer`）即时切换活动密钥注册表，并为所有新旧配置中 `id` 相同的密钥平滑继承累计观测计数器（`requests_total`、`ok`、`errors`、`cache_hits`、`rate_limited`、`unauthorized`、`waited`、`granted`、`timeout`、`full`、`canceled`、`wait_ms_total`、`wait_ms_max`）；
  - 若热重载遇到文件不可读、JSON 语法或未知字段错误、摘要冲突或配额越界，服务端仅输出不含任何明文凭据或摘要的脱敏告警日志，并**保持原有活动密钥注册表继续生效**。
