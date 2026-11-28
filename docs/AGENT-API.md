# Agent 接口调用指南（Personal Agent Channel）

本文档面向命令行脚本、后台任务与自动化 Agent，说明如何使用 Bearer 鉴权凭据（`DOKITOOL_OWNER_TOKEN` 或 `DOKITOOL_API_KEYS_FILE` 中的多角色密钥：`owner` / `agent` / `friend`）调用 DokiTool 统一媒体 v1（`schema_version=1.0`）接口完成高吞吐解析、状态观测与直链提取。

- 开箱即用的零第三方依赖 Python 3.9+ Agent CLI 与默认只读 Stdio MCP Server 见 [tools/dokitool-agent/README.md](../tools/dokitool-agent/README.md) 与 [tools/dokitool-agent/SKILL.md](../tools/dokitool-agent/SKILL.md)（支持 `platforms` / `parse` / `resolve` / `download` / `subtitles`，含 `DOKITOOL_API_TOKEN` 优先与 `DOKITOOL_OWNER_TOKEN` 兼容、逐跳公网 IP pinning、默认 no-clobber 防覆盖及 `json3`/VTT/SRT/双语字幕提取）。
- 完整的批量下载工程实践与独立标准库参考脚本见 [docs/AGENT-BATCH-DOWNLOAD.md](AGENT-BATCH-DOWNLOAD.md) 与 [examples/agent_batch_download.py](../examples/agent_batch_download.py)。
- 多密钥 SHA-256 注册表配置规范、角色默认值及 `SIGHUP` 热重载说明见 [docs/CONFIGURATION.md](CONFIGURATION.md)，脱敏配置文件示例见 [ops/examples/api-keys.example.json](../ops/examples/api-keys.example.json)。
- 机器可读 OpenAPI `3.1.0` 契约见 [docs/openapi.json](openapi.json)；底层 JSON Schema 真值见 [docs/schema/unified-v1/unified-v1.schema.json](schema/unified-v1/unified-v1.schema.json)。

---

## 1. 适用范围与平台边界

### 1.1 主支持范围（Agent 批量直下目标）

个人 Agent 通道的核心设计目标是**抖音（`douyin`）、X（`x`）及其他返回公开 CDN 直链的平台**（如快手 `kuaishou`、哔哩哔哩 `bilibili`、小红书 `xiaohongshu`、今日头条 `toutiao`、皮皮虾 `pipixia`、皮皮搞笑 `pipigx`、最右图片 `zuiyou`、Pinterest `pinterest`、TikTok `tiktok`、Instagram `instagram`、Facebook `facebook`、Tumblr `tumblr`）。当服务端启用 `DOKITOOL_YTDLP_GENERIC_ENABLED` 时，`GET /api/parse` 在 `platform=all`（或省略 `platform`）模式下还支持第二级通用具名提取器兜底（覆盖 Vimeo、Reddit、SoundCloud 等长尾公网站点，严格禁用 `generic` 盲抓提取器，返回规范化动态 `data.platform` 标识）；若密钥配置了非空 `platforms` 白名单，须在白名单中显式包含 `"ytdlp_generic"` 方可访问第二级通用兜底（未配置 `platforms` 的密钥默认允许全部核心平台与第二级通用兜底）。这些平台的媒体字节由客户端直接向平台 CDN 拉取，服务端仅负责解析与统一契约输出，不中转任何媒体流量。

### 1.2 不在主批量范围内的平台

以下三个平台**不在 Agent 批量下载主支持范围内**：

1. **YouTube（`youtube`）**：
   - 线上标准产品路径使用 **Chrome MV3 原生侧边栏扩展（`v4.7.0`）**，由扩展直接请求 `www.youtube.com` 获取流清单并通过 `/api/youtube/context` + `/api/youtube/finalize` 完成签名解算与本地 `offscreen` OPFS `Mediabunny` 无损音视频合并（纯 Web 端在未检测到扩展时合成客户端级 `HELPER_REQUIRED` 提示状态引导安装扩展）。
   - 在默认未开启 `DOKITOOL_YTDLP_YOUTUBE_ENABLED` 的服务端上，对 YouTube 链接调用 `GET /api/parse` 会直接返回 HTTP `503`（`code: "SERVICE_NOT_CONFIGURED"`）；即便在自建实例上开启服务端提取器，`*.googlevideo.com` 媒体直链通常绑定服务端出口 IP，异地客户端直连下载仍会被拒绝。Agent 批量任务应在输入阶段直接过滤或跳过 YouTube 链接。
2. **TikTok（`tiktok`）出口边界说明**：
   - 独立 Agent API 调用 `GET /api/parse` 时完整保留服务端原生 Go 解析能力（自建配置 `DOKITOOL_TIKTOK_PROXY_URL` 或出口未被风控时可正常返回）；在普通云机房直连部署下，TikTok 上游可能触发 `SlardarWAF` 并返回 `403 UPSTREAM_BLOCKED`，且返回的公开视频直链标注 `browser_fetch: "blocked"`（直连下载须附带 `Referer: https://www.tiktok.com/`、零 `Cookie`）。桌面交互使用场景建议通过 Chrome MV3 官方扩展（`v4.7.0+` `tiktok_parse`）走客户端协同解析与 DNR `1009` 直下，不要求独立 Agent API 提供同等覆盖。
3. **微博（`weibo`）**：
   - 微博不在主批量支持范围内：DokiTool 注册的微博能力仅为 `["video"]`（不支持纯图片微博图文提取；非视频微博状态帖会返回 `404 CONTENT_UNAVAILABLE` 或因上游状态接口访客限制返回 `403 UPSTREAM_BLOCKED`）。
   - **统一零中转直链服务端行为（`v4.6.0+`）**：无论匿名访客还是携带有效 Bearer 密钥（`owner`、`agent`、`friend`），调用 `/api/parse` 解析公开微博视频（例如 `https://weibo.com/tv/show/1034:...`）时，服务端均走统一 `PreparePublic` 分支，**不签发任何本站中转票据**（历史 `/api/media/weibo` 已退役），直接返回原始 CDN 直链（视频流位于 `*.weibocdn.com` 并标注 `browser_fetch: "blocked"`，封面与头像位于 `*.sinaimg.cn`）并接入服务端进程内解析缓存。
   - **直连下载微博原始 CDN 链接的 `Referer` 实测要求**：微博音视频与图片 CDN 均校验 `Referer` 防盗链。若客户端确需直连下载返回的 `*.weibocdn.com` 或 `*.sinaimg.cn` 原始直链，**必须附带请求头 `Referer: https://weibo.com/`（无需且不应携带任何 `Cookie`，严禁转发 `Authorization` 头）**。对公开微博视频帖与图片帖原始 CDN 直链执行只读 `Range: bytes=0-1023` 的实测结果如下：

     | 资源类型 | 原始 CDN 主机名 | Case A：无 `Referer`、无 `Cookie` | Case B：`Referer: https://weibo.com/`、无 `Cookie` |
     | --- | --- | --- | --- |
     | 公开微博视频流（`PreparePublic` 返回） | `f.video.weibocdn.com` | HTTP `403` | HTTP `206`（`video/mp4`） |
     | 公开微博视频封面（`PreparePublic` 返回） | `wx4.sinaimg.cn` | HTTP `403` | HTTP `206`（`image/jpeg`） |
     | 公开微博图片帖原图（图片 CDN 直测） | `wx2.sinaimg.cn` / `wx3.sinaimg.cn` | HTTP `403` | HTTP `206`（`image/jpeg`） |

---

## 2. 认证方式与鉴权安全规则

### 2.1 读取与传递令牌

服务端支持两类并存的 Bearer 鉴权凭据来源（令牌须为 `32–512` 字节、不含空白或控制字符的可打印 ASCII 字符串，服务端仅保存 SHA-256 摘要并执行无提前退出的常量时间扫描）：
1. **环境变量 `DOKITOOL_OWNER_TOKEN`**：非空时自动创建隐式 `id: "owner"`（`role: "owner"`）密钥；
2. **多密钥配置文件 `DOKITOOL_API_KEYS_FILE`**：最多支持 `64` 把密钥（含隐式 `"owner"`），支持 `owner`、`agent`、`friend` 三种角色、按密钥独立并发池与速率限流、可选 `platforms` 平台白名单以及 `SIGHUP` 原子热重载（配置 Schema、离线 `printf '%s' "$TOKEN" | ./dokitool hash-token` 生成方式见 [docs/CONFIGURATION.md](CONFIGURATION.md) 与 [ops/examples/api-keys.example.json](../ops/examples/api-keys.example.json)）。

客户端应始终从环境变量读取令牌，并通过 **`Authorization: Bearer <token>` 请求头**发送：

```bash
export DOKITOOL_OWNER_TOKEN='<your-owner-token-from-secret-store>'

curl --fail-with-body --silent --show-error --get 'https://snap.example.com/api/parse' \
  --header "Authorization: Bearer ${DOKITOOL_OWNER_TOKEN}" \
  --data-urlencode 'schema_version=1.0' \
  --data-urlencode 'url=https://www.douyin.com/video/EXAMPLE_ID'
```

**强制安全约束**：
- **仅接受 `Authorization` 请求头**：单次请求仅允许携带 1 个 `Authorization` 头，前缀必须精确区分大小写为 `"Bearer "`（后接单个空格与令牌），整行请求头总长度不得超过 **`1024` 字节**。
- **严禁放入 URL 查询参数**：服务端仅从 `Authorization` 请求头读取令牌。在 `/api/parse`、`/api/resolve`、`/api/platforms` 中，查询参数里的令牌（如 `?token=...`、`?owner_token=...`）会被忽略，请求按**匿名访客**处理（例如未命中缓存的匿名 `/api/parse` 受单 IP `Burst=4`、`0.2/s` 限流，纯 Go 平台的匿名 `/api/resolve` 走独立的 `Resolve` 池〔单 IP `Burst=12`、`0.5/s`、并发 `2`〕，命中进程内新鲜缓存的 `/api/parse` 与 `/api/resolve` 走轻量的 `Catalog` 池），**不会报错提醒**（仅 `GET /api/stats` 会在缺少请求头时返回 `401`、在已带有效请求头时拒绝多余的查询参数并返回 `400 INVALID_INPUT`）；同时查询参数里的令牌还会暴露在日志和终端历史里。
- **严禁向第三方 CDN 转发凭据**：`/api/parse` 与 `/api/resolve` 返回的媒体 URL 指向抖音、X 等第三方平台 CDN。下载媒体字节时**绝对禁止携带 `Authorization` 头或任何 `Cookie`**。

### 2.2 鉴权失败的精确行为（HTTP `401` 与防暴力限流 `429`）

> **关键行为（客户端必须特殊处理）**：
> 当请求附带了 `Authorization` 头（或在强制要求鉴权的 `GET /api/stats` 上缺失 `Authorization` 头），且出现以下任一情形时：
> 1. 令牌内容错误，或命中已停用密钥（`enabled: false`）；
> 2. 格式畸形（非 `"Bearer "` 前缀、空令牌、含空白字符或非可打印 ASCII 字节）；
> 3. `Authorization` 请求头长度超过 **`1024` 字节**，或同一请求发送了多个 `Authorization` 头；
> 4. 服务端未配置任何已启用的 Bearer 凭据（`DOKITOOL_OWNER_TOKEN` 与 `DOKITOOL_API_KEYS_FILE` 均未启用匹配密钥）；
>
> 服务端**绝不会静默降级为匿名请求**，而是执行以下两步固定动作：
> 1. **计入匿名单 IP 限流预算**：每次失败尝试都会向该来源客户端 IP（IPv6 按 `/64` 前缀聚合）的匿名解析单 IP 令牌桶扣减 1 个令牌（默认 **`Burst=4`**，恢复速率 **`0.2/s`**，即每 5 秒恢复 1 个令牌；不消耗全局匿名配额或并发槽位）。
> 2. **返回 `401` 或升级为 `429`**：
>    - 在单 IP 突发配额耗尽前（前 4 次失败），返回 **HTTP `401 Unauthorized`**，响应头含 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`，JSON 载荷遵循统一契约错误格式，**业务错误码固定为 `code: "INVALID_INPUT"`（`error.code: "INVALID_INPUT"`，`error.retryable: false`）**：
>      ```json
>      {
>        "schema_version": "1.0",
>        "code": "INVALID_INPUT",
>        "error": {
>          "code": "INVALID_INPUT",
>          "message": "认证凭据无效",
>          "retryable": false
>        }
>      }
>      ```
>    - 同一 IP 连续第 5 次及之后的无效鉴权请求会被单 IP 令牌桶直接拦截，转为返回 **HTTP `429 Too Many Requests`**（`code: "RATE_LIMITED"`，附带 `Retry-After: 5` 响应头及 `error.retry_after_seconds: 5`）。
> - **已认证密钥的角色或平台白名单越权（同样返回 HTTP `401`）**：若令牌本身合法且已启用，但（a）使用 `agent` 或 `friend` 角色密钥访问仅限 `owner` 的 `GET /api/stats`，或（b）密钥配置了 `platforms` 白名单却请求未授权平台的 `/api/parse`、`/api/resolve` 或 YouTube 助手接口，服务端会校验该密钥自身的快读速率桶（高频洪泛时返回 `429`）、累加该密钥的 `unauthorized` 计数并返回 HTTP `401`（`code: "INVALID_INPUT"`，`error.retryable: false`），不扣减匿名单 IP 令牌桶。

**Agent 实现铁律**：判断错误类型时**必须优先检查 HTTP 状态码是否为 `401`**，不能只看 JSON 里的 `code == "INVALID_INPUT"`。收到 HTTP `401` 代表令牌配置错误或服务端未开启个人通道，Agent 必须**立即终止整个批处理任务并告警**，切勿将其当作单条分享链接格式错误跳过并继续请求后续 URL。

---

## 3. 接口参考

所有接口响应均设置 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。在 `/api/parse`、`/api/resolve` 与 `/api/platforms` 中，未定义的额外查询参数（包括误放在 `?token=...` 中的令牌）会被直接忽略且不会报错；只有 `GET /api/stats`（通过请求头鉴权后）会拒绝除可选 `schema_version` 外的多余查询参数或末尾裸 `?` 并返回 HTTP `400 INVALID_INPUT`。

### 3.1 `GET /api/parse` — 解析分享链接或分享口令文本

- **认证**：可选 `Authorization: Bearer <token>`（支持 `owner`、`agent`、`friend` 三种角色；携带时先校验可选 `platforms` 白名单〔第二级通用兜底需非空白名单包含 `"ytdlp_generic"`，否则返回 HTTP `401`〕，命中进程内新鲜缓存时直接走零槽位缓存快路径，未命中缓存时进入该密钥独立的并发池与等待队列〔第二级通用兜底计入 `slow_concurrency` 慢解析子并发上限〕；不带时命中新鲜缓存走匿名 `Catalog` 池，未命中按两级路由分别进入匿名快解析池、核心慢解析池或独立隔离的 `PARSE_GENERIC` 长尾慢解析池）。
- **查询参数**：
  | 参数名 | 必填 | 约束与说明 |
  | --- | --- | --- |
  | `schema_version` | **是** | 固定为 `"1.0"`。缺失、数组形式（如 `schema_version[]=`）或值不等于 `"1.0"` 时返回 HTTP `409`（`code: "INVALID_INPUT"`；携带有效 Bearer 凭据时返回明确提示文案 `"请传入必需查询参数 schema_version=1.0（详见 docs/AGENT-API.md）"`，匿名访客保持浏览器刷新提示不变）。 |
  | `url` | **是** | 作品分享链接或包含单个 `http(s)` 链接的分享口令文本（整体长度 `<= 8192` 字节；海外 `yt-dlp` 平台与第二级通用兜底提取出的 URL 长度 `<= 2048` 字节，且第二级通用兜底额外拒绝 `#fragment`、内网/本机主机名、本站域名及空路径+空查询）。服务端自动提取首个 `http(s)` URL 并剥离尾随标点。 |
  | `platform` | 否 | 指定平台 ID（见 `/api/platforms`）或 `"all"`。省略或传 `"all"` 时执行两级路由：优先按域名命中核心目录；若服务端启用 `DOKITOOL_YTDLP_GENERIC_ENABLED`，未命中核心目录的合法公网链接自动进入第二级通用具名提取器兜底并返回规范化动态 `data.platform`（缓存 TTL 上限 `60s`）。显式指定具体平台 ID 时绝不触发第二级通用兜底，与链接实际平台不一致则返回 HTTP `400`。 |
  | `debug` | 否 | 传 `"1"` 时启用完整规范化诊断视图（保留被默认产品视图折叠的同规格备选 `mux` 等候选）；省略或传其他值均按常规产品视图处理。常规批量下载无需传 `debug=1`。 |
- **缓存与容错响应头**：命中进程内新鲜缓存时返回 `X-DokiTool-Cache: hit`；当上游触发熔断保护或实时解析遇到可重试上游故障（`UPSTREAM_TIMEOUT` / `UPSTREAM_UNAVAILABLE` / 上游 `RATE_LIMITED`）且存在未超过 `earliest_expires_at - 15s` 硬顶的过期缓存副本时，服务端通过 `stale-if-error` 返回 HTTP `200 OK` 并附带 `X-DokiTool-Cache: stale`。`UPSTREAM_BLOCKED` 默认短负缓存 `5s`（可通过热配置 `cache.upstream_blocked_neg_ttl` 调整或置 `0s` 关闭），YouTube 服务端 `/api/parse` 默认短缓存 `120s`（受 `cache.youtube_parse_ttl` 与 `earliest_expires_at - 60s` 共同约束，置 `0s` 关闭）。

- **成功响应（HTTP `200 OK`）示例**：
  ```json
  {
    "schema_version": "1.0",
    "code": "OK",
    "data": {
      "platform": "douyin",
      "content_id": "EXAMPLE_AWEME_ID",
      "source_url": "https://www.douyin.com/video/EXAMPLE_AWEME_ID",
      "title": "示例作品标题",
      "generated_at": "2026-11-15T00:00:00Z",
      "author": {
        "id": "EXAMPLE_AUTHOR_ID",
        "name": "示例作者"
      },
      "cover": {
        "url": "https://media-cover.example.test/cover.jpeg"
      },
      "items": [
        {
          "id": "video-1",
          "type": "video",
          "state": "ready",
          "title": "视频",
          "index": 1,
          "variants": [
            {
              "id": "original-h265-2160p",
              "label": "原画",
              "provenance": "original_endpoint",
              "metadata": {
                "container": "mp4",
                "extension": "mp4",
                "mime_type": "video/mp4",
                "width": 2160,
                "height": 3840,
                "duration_ms": 15200,
                "fps": 60,
                "video_codec": "hevc",
                "has_audio": true,
                "evidence": "probe"
              },
              "delivery": {
                "kind": "file",
                "sources": [
                  {
                    "id": "shanghai-1",
                    "url": "https://sh-vod.example.test/media/video.mp4",
                    "fallback_urls": [
                      "https://sh-vod.example.test/media/video-alt.mp4"
                    ],
                    "access": "direct",
                    "size_bytes": 18452910,
                    "expires_at": "2026-11-15T01:00:00Z",
                    "availability": "available"
                  },
                  {
                    "id": "origin-1",
                    "url": "https://global-vod.example.test/media/video.mp4",
                    "access": "direct",
                    "size_bytes": 18452910,
                    "expires_at": "2026-11-15T01:00:00Z",
                    "availability": "unknown"
                  }
                ]
              }
            }
          ],
          "default": {
            "variant_id": "original-h265-2160p",
            "source_id": "shanghai-1",
            "url": "https://sh-vod.example.test/media/video.mp4",
            "access": "direct",
            "expires_at": "2026-11-15T01:00:00Z"
          }
        }
      ],
      "attachments": [
        {
          "id": "bgm-1",
          "role": "background_audio",
          "title": "背景音乐",
          "resource": {
            "id": "bgm-audio-1",
            "role": "audio",
            "metadata": {
              "container": "mp3",
              "extension": "mp3",
              "mime_type": "audio/mpeg",
              "evidence": "upstream"
            },
            "delivery": {
              "kind": "file",
              "sources": [
                {
                  "url": "https://music.example.test/bgm.mp3"
                }
              ]
            }
          }
        }
      ]
    }
  }
  ```

### 3.2 `GET /api/resolve` — 按需解析延迟分集（如哔哩哔哩多 P）

当 `/api/parse` 返回多 P 合集（`data.groups[*].kind == "multipart"`）时，非首集条目通常处于 `state: "deferred"` 状态，不含 `variants`，但提供 API 相对路径 **`item.resolve_url`**（例如 `"/api/resolve?schema_version=1.0&platform=bilibili&url=...&item_id=..."`）。

- **认证**：可选 `Authorization: Bearer <token>`（支持 `owner`、`agent`、`friend` 角色；Agent 调用时应继续携带同一请求头，命中新鲜缓存走零槽位缓存快路径，未命中进入该密钥独立池；不带时命中新鲜缓存走匿名 `Catalog` 池，未命中缓存时纯 Go 平台走独立的 `Resolve` 池〔单 IP `Burst=12`、`0.5/s`、并发 `2`〕，海外慢解析平台走慢解析池）。
- **查询参数**：
  | 参数名 | 必填 | 约束与说明 |
  | --- | --- | --- |
  | `schema_version` | **是** | 固定为 `"1.0"`（缺失或不匹配返回 HTTP `409`）。 |
  | `url` | **是** | 原始作品链接（须直接使用 `resolve_url` 中给出的参数）。 |
  | `item_id` | **是** | 目标分集的不透明标识（长度 `1..256`，仅允许 ASCII 可打印非空白字符）。**严禁客户端自行拼接或跨作品借用 `item_id`**。 |
  | `platform` | 否 | 平台 ID（`resolve_url` 已自动携带，目前支持按需解析的平台为 `bilibili`）。 |
  | `debug` | 否 | `"1"` 或省略。 |
- **直接使用 `resolve_url` 的推荐写法**：将 API 基础源站（如 `https://snap.example.com`）与 `item.resolve_url` 直接拼接后发起带 `Authorization` 头的 `GET` 请求。响应结构与 `/api/parse` 完全一致，其中目标 `item_id` 对应的条目将变为 `state: "ready"` 并填充 `variants` 与 `default`。

### 3.3 `GET /api/platforms` — 查询当前实例已启用的平台目录

- **认证**：可选 `Authorization: Bearer <token>`（携带有效 `owner` / `agent` / `friend` 密钥时走零槽位快读路径，不占用密钥并发槽位；不带时走匿名 `CATALOG` 池）。
- **查询参数**：`schema_version=1.0`（**必填**，缺失或不匹配返回 HTTP `409`；其他未定义的查询参数会被忽略）。
- **成功响应（HTTP `200 OK`）示例**：
  ```json
  {
    "schema_version": "1.0",
    "code": "OK",
    "data": {
      "platforms": [
        {
          "id": "douyin",
          "name": "抖音",
          "site_url": "https://www.douyin.com/",
          "icon": "douyin",
          "capabilities": ["video", "image", "live_photo"]
        },
        {
          "id": "x",
          "name": "X",
          "site_url": "https://x.com/",
          "icon": "x",
          "capabilities": ["video", "image"]
        }
      ]
    }
  }
  ```
- **用途**：Agent 可在批处理启动前请求一次 `/api/platforms?schema_version=1.0`，确认目标自建/线上实例是否已启用 `x`、`instagram` 等可选平台，避免对未启用平台重复发起请求。

### 3.4 `GET /api/stats` — 查询进程内只读运行统计快照

提供当前 `dokitool` 进程自启动以来的请求计数、缓存命中与过期兜底命中（`stale_hits`）、`fast` / `slow` / `generic_slow` / `owner` 四池排队与拒绝计数、按密钥维度的 `api_keys` 池状态与累计计数、`ytdlp` 与 `ytdlp_generic` 并发槽位等待直方图、分舱水位 `ytdlp_pools`（`youtube` / `social` / `generic` / `youtube_ejs`）、16 个核心平台熔断状态列表（`circuit_breakers`）、脱敏热配置生效策略摘要（`runtime_policy`）、抖音与哔哩哔哩上海通道工作状态、端到端解析耗时直方图、只读脱敏运行开关（`runtime`）以及按 `Asia/Shanghai`（UTC+8）统计的近 30 天日桶（`daily`）与近 24 小时时桶（`hourly`）。仅统计聚合计数器、运行开关、策略数值与密钥标识，不含任何 URL、IP、宿主机路径、明文令牌或摘要内容。

- **认证**：**严格要求 `owner` 角色 Bearer 凭据**（`DOKITOOL_OWNER_TOKEN` 隐式 `owner` 密钥或 `DOKITOOL_API_KEYS_FILE` 中的 `role: "owner"` 密钥）。缺失、错误、已停用（`enabled: false`）、格式畸形、超长（`> 1024` 字节）、重复 `Authorization` 头或未配置任何启用密钥时，均扣减匿名单 IP 配额并返回 HTTP `401`（`code: "INVALID_INPUT"`，连续失败第 5 次起返回 HTTP `429`）；携带合法 `agent` 或 `friend` 角色密钥访问时同样返回 HTTP `401`（`code: "INVALID_INPUT"`，`retryable: false`，计入该密钥 `unauthorized` 计数，不扣减匿名单 IP 配额）。**通过 `owner` 鉴权的 `/api/stats` 请求不占用并发槽位，也不计入 `requests` 解析统计**。
- **HTTP 方法与查询参数**：
  - 仅允许 `GET`（通过鉴权的非 `GET` 请求返回 HTTP `405 INVALID_INPUT` 及 `Allow: GET` 头）。
  - 查询参数 `schema_version` **可选**：不带查询串（`GET /api/stats`）或携带 `?schema_version=1.0` 均返回同一结构；若标量 `schema_version` 传入非 `"1.0"` 的其他值（包括空值）则返回 HTTP `409 INVALID_INPUT`；携带任何其他查询键（包括 `?token=...`、`schema_version[]=`）、空 `&` 段或末尾裸 `?`（`/api/stats?`）均返回 HTTP `400 INVALID_INPUT`。
- **成功响应（HTTP `200 OK`）示例**：
  ```json
  {
    "schema_version": "1.0",
    "code": "OK",
    "data": {
      "started_at": "2026-11-15T00:00:00Z",
      "generated_at": "2026-11-15T01:30:00Z",
      "uptime_seconds": 5400,
      "requests": {
        "total": 128,
        "by_channel": {
          "anonymous": 28,
          "owner": 100
        },
        "by_platform_code_channel": [
          {
            "platform": "douyin",
            "code": "OK",
            "channel": "owner",
            "count": 72
          },
          {
            "platform": "x",
            "code": "OK",
            "channel": "owner",
            "count": 28
          }
        ]
      },
      "cache": {
        "enabled": true,
        "entries": 85,
        "bytes": 312480,
        "max_entries": 4096,
        "max_bytes": 67108864,
        "total": {
          "hits": 24,
          "stale_hits": 1,
          "misses": 100,
          "singleflight_shared": 4,
          "uncacheable": 0
        },
        "by_channel": {
          "anonymous": {
            "hits": 6,
            "stale_hits": 0,
            "misses": 20,
            "singleflight_shared": 2,
            "uncacheable": 0
          },
          "owner": {
            "hits": 18,
            "stale_hits": 1,
            "misses": 80,
            "singleflight_shared": 2,
            "uncacheable": 0
          }
        }
      },
      "admission": {
        "fast": {
          "active": 0,
          "queued": 0,
          "concurrency_limit": 64,
          "queue_limit": 128,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "slow": {
          "active": 0,
          "queued": 0,
          "concurrency_limit": 4,
          "queue_limit": 32,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "generic_slow": {
          "active": 0,
          "queued": 0,
          "concurrency_limit": 2,
          "queue_limit": 16,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "owner": {
          "active": 2,
          "queued": 0,
          "concurrency_limit": 8,
          "queue_limit": 256,
          "waited": 5,
          "granted": 5,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 640,
          "wait_ms_max": 210
        }
      },
      "ytdlp": {
        "enabled": true,
        "active": 0,
        "waiting": 0,
        "concurrency_limit": 2,
        "total": {
          "acquired_count": 12,
          "wait_count": 1,
          "canceled_count": 0,
          "wait_ms_total": 180,
          "wait_ms_max": 180,
          "wait_ms": {
            "count": 1,
            "sum_ms": 180,
            "max_ms": 180,
            "buckets": {
              "<=10": 0,
              "<=50": 0,
              "<=100": 0,
              "<=250": 1,
              "<=500": 1,
              "<=1000": 1,
              "<=2500": 1,
              "<=5000": 1,
              "<=10000": 1,
              "<=30000": 1,
              "+Inf": 1
            }
          }
        },
        "by_channel": {
          "anonymous": {
            "acquired_count": 2,
            "wait_count": 0,
            "canceled_count": 0,
            "wait_ms_total": 0,
            "wait_ms_max": 0,
            "wait_ms": {
              "count": 0,
              "sum_ms": 0,
              "max_ms": 0,
              "buckets": {
                "<=10": 0, "<=50": 0, "<=100": 0, "<=250": 0, "<=500": 0,
                "<=1000": 0, "<=2500": 0, "<=5000": 0, "<=10000": 0, "<=30000": 0, "+Inf": 0
              }
            }
          },
          "owner": {
            "acquired_count": 10,
            "wait_count": 1,
            "canceled_count": 0,
            "wait_ms_total": 180,
            "wait_ms_max": 180,
            "wait_ms": {
              "count": 1,
              "sum_ms": 180,
              "max_ms": 180,
              "buckets": {
                "<=10": 0, "<=50": 0, "<=100": 0, "<=250": 1, "<=500": 1,
                "<=1000": 1, "<=2500": 1, "<=5000": 1, "<=10000": 1, "<=30000": 1, "+Inf": 1
              }
            }
          }
        }
      },
      "ytdlp_generic": {
        "enabled": false,
        "active": 0,
        "waiting": 0,
        "concurrency_limit": 0,
        "total": {
          "acquired_count": 0,
          "wait_count": 0,
          "canceled_count": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0,
          "wait_ms": {
            "count": 0,
            "sum_ms": 0,
            "max_ms": 0,
            "buckets": {
              "<=10": 0, "<=50": 0, "<=100": 0, "<=250": 0, "<=500": 0,
              "<=1000": 0, "<=2500": 0, "<=5000": 0, "<=10000": 0, "<=30000": 0, "+Inf": 0
            }
          }
        },
        "by_channel": {
          "anonymous": {
            "acquired_count": 0,
            "wait_count": 0,
            "canceled_count": 0,
            "wait_ms_total": 0,
            "wait_ms_max": 0,
            "wait_ms": {
              "count": 0,
              "sum_ms": 0,
              "max_ms": 0,
              "buckets": {
                "<=10": 0, "<=50": 0, "<=100": 0, "<=250": 0, "<=500": 0,
                "<=1000": 0, "<=2500": 0, "<=5000": 0, "<=10000": 0, "<=30000": 0, "+Inf": 0
              }
            }
          },
          "owner": {
            "acquired_count": 0,
            "wait_count": 0,
            "canceled_count": 0,
            "wait_ms_total": 0,
            "wait_ms_max": 0,
            "wait_ms": {
              "count": 0,
              "sum_ms": 0,
              "max_ms": 0,
              "buckets": {
                "<=10": 0, "<=50": 0, "<=100": 0, "<=250": 0, "<=500": 0,
                "<=1000": 0, "<=2500": 0, "<=5000": 0, "<=10000": 0, "<=30000": 0, "+Inf": 0
              }
            }
          }
        }
      },
      "ytdlp_pools": {
        "youtube": {
          "enabled": true,
          "active": 0,
          "queued": 0,
          "concurrency_limit": 4,
          "queue_limit": 32,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "social": {
          "enabled": true,
          "active": 0,
          "queued": 0,
          "concurrency_limit": 4,
          "queue_limit": 32,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "generic": {
          "enabled": false,
          "active": 0,
          "queued": 0,
          "concurrency_limit": 2,
          "queue_limit": 16,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        },
        "youtube_ejs": {
          "enabled": true,
          "active": 0,
          "queued": 0,
          "concurrency_limit": 6,
          "queue_limit": 64,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        }
      },
      "circuit_breakers": [
        {"platform": "douyin", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 10, "open_until": "", "disabled_by_config": false},
        {"platform": "bilibili", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "weibo", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "toutiao", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "kuaishou", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "pipixia", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "pipigx", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "zuiyou", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "xiaohongshu", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "pinterest", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "tiktok", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "x", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 10, "open_until": "", "disabled_by_config": false},
        {"platform": "youtube", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "instagram", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "facebook", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false},
        {"platform": "tumblr", "state": "closed", "consecutive_failures": 0, "window_failures": 0, "window_total": 0, "open_until": "", "disabled_by_config": false}
      ],
      "runtime_policy": {
        "config_file_active": true,
        "reload_count": 0,
        "last_reloaded_at": "",
        "youtube_slots": 4,
        "social_slots": 4,
        "generic_slots": 2,
        "youtube_ejs_concurrency": 6,
        "fast_per_platform_max_concurrency": 24,
        "circuit_breaker_enabled": true,
        "disabled_platforms": [],
        "youtube_parse_ttl_seconds": 120,
        "stale_if_error_ttl_seconds": 600,
        "upstream_blocked_neg_ttl_seconds": 5
      },
      "shanghai": {
        "enabled": true,
        "mode": "pull",
        "waiting_workers": 3,
        "queued_tasks": 0,
        "pending_tasks": 0,
        "total": {
          "hits": 70,
          "fallbacks": 2,
          "canceled": 0,
          "queue_waits": 4,
          "queue_granted": 4,
          "queue_timeouts": 2,
          "queue_wait_ms_total": 720,
          "queue_wait_ms_max": 300
        },
        "by_channel": {
          "anonymous": {
            "hits": 0, "fallbacks": 0, "canceled": 0,
            "queue_waits": 0, "queue_granted": 0, "queue_timeouts": 0,
            "queue_wait_ms_total": 0, "queue_wait_ms_max": 0
          },
          "owner": {
            "hits": 70, "fallbacks": 2, "canceled": 0,
            "queue_waits": 4, "queue_granted": 4, "queue_timeouts": 2,
            "queue_wait_ms_total": 720, "queue_wait_ms_max": 300
          }
        },
        "by_platform": {
          "douyin": {
            "hits": 68, "fallbacks": 2, "canceled": 0,
            "queue_waits": 4, "queue_granted": 4, "queue_timeouts": 2,
            "queue_wait_ms_total": 720, "queue_wait_ms_max": 300
          },
          "bilibili": {
            "hits": 2, "fallbacks": 0, "canceled": 0,
            "queue_waits": 0, "queue_granted": 0, "queue_timeouts": 0,
            "queue_wait_ms_total": 0, "queue_wait_ms_max": 0
          }
        }
      },
      "parse_latency_ms": {
        "total": {
          "count": 128,
          "sum_ms": 48200,
          "max_ms": 2140,
          "buckets": {
            "<=10": 24, "<=50": 29, "<=100": 37, "<=250": 69, "<=500": 110,
            "<=1000": 124, "<=2500": 128, "<=5000": 128, "<=10000": 128, "<=30000": 128, "+Inf": 128
          }
        },
        "by_channel": {
          "anonymous": {
            "count": 28, "sum_ms": 9600, "max_ms": 1820,
            "buckets": {
              "<=10": 6, "<=50": 7, "<=100": 9, "<=250": 17, "<=500": 24,
              "<=1000": 27, "<=2500": 28, "<=5000": 28, "<=10000": 28, "<=30000": 28, "+Inf": 28
            }
          },
          "owner": {
            "count": 100, "sum_ms": 38600, "max_ms": 2140,
            "buckets": {
              "<=10": 18, "<=50": 22, "<=100": 28, "<=250": 52, "<=500": 86,
              "<=1000": 97, "<=2500": 100, "<=5000": 100, "<=10000": 100, "<=30000": 100, "+Inf": 100
            }
          }
        }
      },
      "api_keys": [
        {
          "id": "owner",
          "role": "owner",
          "enabled": true,
          "active": 2,
          "slow_active": 0,
          "queued": 0,
          "concurrency_limit": 8,
          "slow_concurrency_limit": 0,
          "queue_limit": 256,
          "requests_total": 80,
          "ok": 80,
          "errors": 0,
          "cache_hits": 14,
          "rate_limited": 0,
          "unauthorized": 0,
          "waited": 5,
          "granted": 5,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 640,
          "wait_ms_max": 210
        },
        {
          "id": "agent-bot",
          "role": "agent",
          "enabled": true,
          "active": 0,
          "slow_active": 0,
          "queued": 0,
          "concurrency_limit": 4,
          "slow_concurrency_limit": 1,
          "queue_limit": 128,
          "requests_total": 20,
          "ok": 20,
          "errors": 0,
          "cache_hits": 4,
          "rate_limited": 0,
          "unauthorized": 0,
          "waited": 0,
          "granted": 0,
          "timeout": 0,
          "full": 0,
          "canceled": 0,
          "wait_ms_total": 0,
          "wait_ms_max": 0
        }
      ],
      "runtime": {
        "version": "1.0.0",
        "shanghai_mode": "pull",
        "shanghai_bilibili": true,
        "bilibili_dash": false,
        "youtube_helper": true,
        "xhs_transport": "chrome131",
        "ytdlp_enabled": true,
        "ytdlp_generic_enabled": false,
        "tbvideo_pipigx": false,
        "tbvideo_zuiyou": false,
        "stats_persistence_enabled": true
      },
      "daily": [
        {
          "date": "2026-11-15",
          "total": 128,
          "ok": 128,
          "failed": 0,
          "cache_hits": 24,
          "shanghai_hits": 70,
          "latency_ms": {
            "p50_ms": 250,
            "p95_ms": 1000,
            "max_ms": 2140
          },
          "by_platform": {
            "douyin": {
              "total": 100,
              "ok": 100,
              "failed": 0,
              "by_code": {
                "OK": 100
              },
              "p95_ms": 500
            },
            "x": {
              "total": 28,
              "ok": 28,
              "failed": 0,
              "by_code": {
                "OK": 28
              },
              "p95_ms": 1000
            }
          }
        }
      ],
      "hourly": [
        {
          "hour_start": "2026-11-15T09:00:00+08:00",
          "total": 128,
          "ok": 128,
          "failed": 0,
          "cache_hits": 24
        }
      ]
    }
  }
  ```
- **核心统计字段说明**：
  - `requests.by_platform_code_channel[*]`：仅输出 `count > 0` 的非零组合，按 `(platform, code, channel)` 稳定排序。`platform` 遵循受控规范化模式 `^[a-z0-9][a-z0-9_:-]{0,31}$`（最长 32 字节），覆盖 16 个核心平台 ID、`"unknown"`、上限 64 个动态长尾提取器标识及溢出桶 `"ytdlp_other"`；`code` 为 `"OK"`、11 个公开契约错误码及内部鉴权拒绝码 `"UNAUTHORIZED"`（共 13 个闭合枚举）；`channel` 为 `"anonymous"` 或 `"owner"`（所有通过鉴权的 Bearer 密钥均汇总至 `"owner"` 渠道）。
  - `admission.{fast,slow,generic_slow,owner}`：`active` 为当前正在执行的请求数，`queued` 为当前在 FIFO 队列等待的请求数，`waited` / `granted` / `timeout` / `full` / `canceled` 为累计入队、获槽、等待超时（`429`）、队列满拒绝（`429`）与客户端中途断开计数（其中 `generic_slow` 独立反映第二级通用具名提取器兜底的 `PARSE_GENERIC` 准入池水位，`owner` 汇总 `owner` 角色池快照并保持向后兼容）。
  - `cache.{total,by_channel.*}.stale_hits`：通过 `stale-if-error` 在熔断打开或上游可重试报错时返回未越界媒体签名过期缓存（`X-DokiTool-Cache: stale`）的累计命中次数。
  - `ytdlp` 与 `ytdlp_generic`：两者采用相同的 `YTDLPStatsSnapshot` 结构，分别反映核心海外提取器共享并发槽位与第二级通用具名提取器独立隔离并发槽位；未启用第二级通用兜底时，`ytdlp_generic.enabled` 为 `false` 且其余字段为 `0`。
  - `ytdlp_pools.{youtube,social,generic,youtube_ejs}`：分舱报告 YouTube 服务端慢池、社交慢池（X / IG / FB / Tumblr）、通用长尾慢池及解耦后的 YouTube EJS 助手池（`/api/youtube/context` 未命中与 `/api/youtube/finalize`）的启用状态、活跃槽位、队列等待与累计排队统计。
  - `circuit_breakers[*]`：按固定顺序返回 16 个核心平台的熔断器只读状态（`state`: `"closed"` / `"open"` / `"half_open"`、`consecutive_failures`、`window_failures`、`window_total`、`open_until`、`disabled_by_config`）。
  - `runtime_policy`：只读脱敏返回当前生效的运行时热配置策略摘要（`config_file_active`、`reload_count`、`last_reloaded_at`、各分舱并发数、快池单平台上限、熔断开关与手动止血列表 `disabled_platforms`、缓存 TTL 秒数；绝不泄露任何本地文件路径或密钥）。
  - `api_keys[*]`：按配置顺序返回每把已注册 API 密钥（最多 `64` 项，未配置时为空数组 `[]`；已停用密钥仍以 `enabled: false` 保留在列表中，绝不返回令牌或 SHA-256 摘要）的实时并发与累计指标，包含固定 22 个字段：`id`、`role`（`"owner"` / `"agent"` / `"friend"`）、`enabled`、`active`、`slow_active`、`queued`、`concurrency_limit`、`slow_concurrency_limit`、`queue_limit`、`requests_total`、`ok`、`errors`、`cache_hits`（零槽位缓存快路径命中次数）、`rate_limited`、`unauthorized`（角色或平台白名单拦截次数）、`waited`、`granted`、`timeout`、`full`、`canceled`、`wait_ms_total`、`wait_ms_max`。`SIGHUP` 热重载时，相同 `id` 的密钥自动延续累计计数。
  - `shanghai`：`mode` 为 `"off"` / `"direct"` / `"pull"`；`pull` 模式下 `waiting_workers` 反映当前空闲待命的上海 `shanghai-resolver` 工作协程数，`hits` 与 `fallbacks` 反映上海国内线路命中与回退本地解析次数，`by_platform.{douyin,bilibili}` 按平台分别统计抖音与哔哩哔哩的上海通道命中、排队与回退次数（哔哩哔哩上海通道受主后端独立开关 `DOKITOOL_SHANGHAI_BILIBILI` 控制，默认关闭时 `by_platform.bilibili` 各项保持为 `0`）。
  - `runtime`：只读脱敏返回 11 项运行开关（`version`、`shanghai_mode`、`shanghai_bilibili`、`bilibili_dash`、`youtube_helper`、`xhs_transport`、`ytdlp_enabled`、`ytdlp_generic_enabled`、`tbvideo_pipigx`、`tbvideo_zuiyou`、`stats_persistence_enabled`），绝不泄露任何宿主机路径、IP、URL 或凭据。
  - `daily` 与 `hourly`：分别按 `Asia/Shanghai`（UTC+8）自然日与整点升序返回滚动统计桶（线上响应固定包含近 30 天日桶与近 24 小时时桶，上方示例为便于阅读仅展示单日/单小时条目）；`daily[*]` 含 `date`（`YYYY-MM-DD`）、`total`、`ok`、`failed`、`cache_hits`、`shanghai_hits`、`latency_ms`（`p50_ms` / `p95_ms` / `max_ms`）及非空平台字典 `by_platform`（各平台含 `total`、`ok`、`failed`、`by_code`、`p95_ms`），`hourly[*]` 含 `hour_start`（RFC 3339 `+08:00`）、`total`、`ok`、`failed`、`cache_hits`。配置 `DOKITOOL_STATS_SNAPSHOT_PATH` 后，日桶与时桶会按原子落盘策略跨重启保留（见 [CONFIGURATION.md](CONFIGURATION.md)）。
  - 直方图（`HistogramSnapshot`）：`buckets` 键集合固定为 `<=10`、`<=50`、`<=100`、`<=250`、`<=500`、`<=1000`、`<=2500`、`<=5000`、`<=10000`、`<=30000`、`+Inf`（单位毫秒，采用 Prometheus 风格的**累积上界桶**，单调不减且 `buckets["+Inf"] == count`）。

---

## 4. 如何从 `unified-v1` 响应中提取媒体文件

### 4.1 顶层结构与条目状态（`data.items[*]`）

成功响应的媒体条目统一位于 `data.items` 数组（至少 1 项；多于 1 项时必含 `data.default_item_id`）：

- **单视频作品**（如抖音短视频、X 单视频推文）：`data.items` 含 1 个 `type: "video"` 条目。
- **多图图集 / 多媒体推文**（如抖音图文、小红书图集、X 4 图或视频+图混排推文）：`data.items` 含多个条目（`type` 可为 `"image"`、`"video"` 或 `"live_photo"`）。批量归档整个作品时应**遍历全部 `data.items[*]`**，而不要只取 `default_item_id`。
- **条目 `state` 字段**（省略时默认为 `"ready"`）：
  1. `"ready"`：已解析完成，包含非空 `variants` 数组以及默认选择投影 `default`。
  2. `"deferred"`：延迟解析分集（如哔哩哔哩多 P 的 P2..Pn），`default` 为 `null`，提供 `resolve_url`——需按需调用 `GET /api/resolve` 获取该分集的 `variants`。
  3. `"unavailable"`：作品中某单集失效（其余有效分集仍可正常下载），含 `error` 对象说明原因，直接记录并跳过该条目即可。
- **附属资源（`data.attachments[*]`）**：独立于主媒体的背景音乐（`role: "background_audio"`，如抖音图文配乐）或外挂字幕（`role: "subtitle"`）存放在 `data.attachments`，不会混入 `items[*].variants`。如需一并保存配乐可按需读取 `attachment.resource.delivery.sources[0].url`。

### 4.2 `item.default` 与 `item.variants[*]` 的选择策略

服务端已按照统一画质优先级（优先完整有声 `file`、最高已验证空间分辨率、未过期直链）为每个 `ready` 条目预先计算好 `item.default`：

1. **常规单文件优先路径（推荐绝大多数 Agent 使用）**：
   - 若 `item.default != null`：
     - `item.default.variant_id` 指向选中的 `variant`（可在 `item.variants` 中查到其 `metadata.extension`、`metadata.mime_type`、`width`、`height` 等规格；注意抖音等部分平台仅返回宽高而省略 `extension` / `mime_type` 且 CDN 路径无后缀，落盘扩展名应按「结果里的字段 → 下载响应 `Content-Type` → 文件开头的特征字节（`ftyp`、JPEG、PNG、WebP、GIF）→ 最后 `.bin`」顺序判定，详见 [AGENT-BATCH-DOWNLOAD.md](AGENT-BATCH-DOWNLOAD.md)）；
     - 若该 `variant` 含多个 CDN 来源，则 `item.default.source_id` 指明默认来源 ID；
     - `item.default.url` 即首选直链，同时应将该 `variant` 下 `delivery.sources[*]` 的其余来源及各来源的 `fallback_urls[*]` 收集为故障切换候选列表。
2. **何时需要直接遍历 `item.variants[*]`**：
   - **`type == "live_photo"`（实况照片，如抖音实况、小红书 Live Photo）**：实况照片由静图与动态视频片段成对组成，其 `delivery.kind` 为 `"pair"`。因 `"pair"` 不是单一文件，按契约规定 **`item.default` 固定为 `null`**（`default_unavailable_reason: "processing_required"`）。此时应读取 `item.variants[0].delivery.resources[*]`，分别下载 `role == "image"` 与 `role == "motion"` 两个子资源。
   - **指定目标清晰度或编码**：例如只想要 `1080p` H.264（`video_codec: "avc"`）而非 `2160p` HEVC（`video_codec: "hevc"`），可在 `item.variants` 中筛选 `state != "deferred"` 且 `delivery.kind == "file"` 的候选。
   - **更高画质分离轨道（`item.higher_quality_variants[*]`）**：当某平台（如哔哩哔哩 1080P（免登录）DASH）存在比最高完整单文件 `file` 分辨率更高的音视频分离版本时，`item.default` 仍指向可直接单文件下载的最高完整 `file`，而 `item.higher_quality_variants` 会列出 `requires: ["mux"]` 的 `variant_id`。仅当 Agent 本地具备 `ffmpeg` 无损混流步骤时才选择 `delivery.kind == "mux"` 的版本。

### 4.3 交付形态（`delivery.kind`）速查表

| `delivery.kind` | 结构位置 | 含义与 Agent 处理方式 |
| --- | --- | --- |
| `file` | `delivery.sources[*]` | **完整单文件**（MP4/MOV 视频、JPEG/PNG/WebP/HEIC 图片、MP3/M4A 音频）。直接流式下载，落盘即用。 |
| `pair` | `delivery.resources[*]`（`role: "image"` + `role: "motion"`） | **实况照片成对资源**。每个 `resource` 内部各有自己的 `metadata` 与 `delivery`（通常均为 `kind: "file"`），分别按各自扩展名保存为 `<stem>_image.<ext>` 与 `<stem>_motion.<ext>`。 |
| `mux` | `delivery.resources[*]`（1 个 `role: "video"` + `>=1` 个 `role: "audio"`） | **音视频分离轨道**。服务端不执行混流；若无需本地 `ffmpeg -c copy` 合并，请直接使用 `item.default` 指向的完整 `file` 版本。 |
| `segments` | `delivery.init`（可选）+ `delivery.pieces[*]` | **显式分片序列**。仅当 `delivery.join == "byte_concat"` 且 `join_evidence == "validated_fragment_layout"` 时可按 `index` 顺序字节拼接；`join == "remux"` 需重封装。 |
| `hls` / `dash` | `delivery.sources[*]`（清单 URL） | **流媒体清单**（例如单流 fMP4 HLS 清单）。批量脚本若未集成清单分片下载器，可明确记录不支持并跳过。 |

> 注意：若单个 `variant` 带有 `"state": "deferred"`，表示它是尚未抓取的预留能力占位项（无 `delivery` 字段），遍历 `variants` 时必须先跳过 `variant.get("state") == "deferred"`。

### 4.4 多线路（`sources[*]`）、备用凭证（`fallback_urls`）与过期时间（`expires_at`）

同一个 `file` 交付下的 `delivery.sources[*]` 代表**同一编码与字节规格的不同 CDN 线路**（例如抖音同时包含上海通道探测出的国内 `*.douyinvod.com` 线路与海外线路）：

1. **跳过不可用或已过期来源**：过滤掉 `source.get("availability") == "unavailable"` 的项；若存在 `source.expires_at`（RFC 3339 时间戳），检查当前时间距离 `expires_at` 是否仍有安全余量（建议至少留出 `30s`；若已临近或过期，重新调用一次 `/api/parse` 刷新直链）。
2. **展开同源备用查询串（`fallback_urls`）**：部分平台（如抖音、皮皮虾）会在同一个 `source` 内附带 `fallback_urls: ["https://..."]`，提供同一 HTTPS 域名下的备用签名查询参数。构建候选 URL 队列时，应按 **`[source.url, *source.fallback_urls]`** 展开，再衔接下一个 `source`，遇到 `403` / 网络超时立即切下一条候选。

---

## 5. 完整错误码参考与 Agent 处置策略

非 `OK` 响应统一采用如下信封结构（不含 `data`）：

```json
{
  "schema_version": "1.0",
  "code": "RATE_LIMITED",
  "error": {
    "code": "RATE_LIMITED",
    "message": "解析请求过于频繁，请稍后重试",
    "retryable": true,
    "retry_after_seconds": 1
  }
}
```

Agent **必须结合 HTTP 状态码与 `error.code` 执行确定性分支处理**：

| HTTP 状态码 | `code` / `error.code` | `retryable` | 触发原因 | Agent 标准处置动作 |
| --- | --- | --- | --- | --- |
| **`401`** | `INVALID_INPUT` | `false` | `Authorization` 令牌错误、命中已停用密钥（`enabled: false`）、格式非法、超长（`> 1024 B`）、重复发送、服务端未启用任何密钥（上述情形还会扣减匿名单 IP 突发配额），或合法 `agent` / `friend` 密钥调用 `/api/stats`、或密钥请求超出其 `platforms` 平台白名单 | **立即中止任务或核查密钥权限范围**：若为无效凭据或 `/api/stats` 角色不符，检查环境变量与目标服务端配置，**严禁对同一无效凭据循环重试**；若为 `platforms` 白名单限制，仅向允许平台发送请求。 |
| `400` / `405` / `409` / `410` | `INVALID_INPUT` | `false` | 缺少/非法 `url` 或 `item_id`、`/api/stats` 携带未知查询参数、`platform` 与链接不匹配、抖音合集 `mix_id`、小红书缺失 `xsec_token`、X `t.co` 短链未指向有效推文页、Facebook `fb.watch` 短链、`schema_version` 不匹配（`409`）、方法错误（`405`）、旧路径退役（`410`） | **不重试**；将该条输入标记为永久输入错误（`failed_permanent`）并继续处理下一条 URL。 |
| `400` | `UNSUPPORTED_PLATFORM` | `false` | 链接域名不在支持目录（如未接入网站），或目标平台在当前实例未启用 | **不重试**；标记为不支持平台并跳过。 |
| `404` | `NO_MEDIA` | `false` | 帖子公开存在但不含受支持媒体（如 X 纯文本推文、仅含不受支持流格式的作品） | **不重试**；标记为无媒体作品并跳过。 |
| `404` | `CONTENT_UNAVAILABLE` | `false` | 作品已删除、不存在，或请求的 `item_id` 不存在（服务端会负缓存 `10s`） | **不重试**；标记为作品不可用并跳过。 |
| `403` | `UPSTREAM_BLOCKED` | `false` | 作品私密、年龄受限、需登录查看（如 Instagram Stories、私密帖、未开回退的 X 受限推文）或触发上游页面风控（服务端默认短负缓存 `5s`，不计入平台熔断） | **不在紧循环中重试**；标记为受限/风控阻塞并跳过。 |
| **`429`** | `RATE_LIMITED` | `true` | `owner` 等待队列已满或排队满 `60s` 超时、快池单平台并发舱壁满载、上游平台返回 `429`，或鉴权失败累计触发单 IP 限流 | **退避后重试**（单条最多 2–3 次）：优先读取 `error.retry_after_seconds` 或 HTTP `Retry-After` 头（默认至少等待 `1s`）并加少量随机抖动；若此前曾发过无效 token，先排查鉴权配置。 |
| `504` | `UPSTREAM_TIMEOUT` | `true` | 上游平台页面/API 在解析预算内超时 | **有限指数退避重试**（最多 1–2 次，例如等待 `2s` -> `5s`），仍失败则记入失败清单留待后续人工或低峰补跑。 |
| `502` / `503` | `UPSTREAM_UNAVAILABLE` | `true` | 上游接口暂时不可用（`502`），或平台熔断器 / `disabled_platforms` 处于快速保护打开态且无可用过期缓存（`503`，携带 `Retry-After` 头与 `error.retry_after_seconds`） | **遵循 `Retry-After` / `retry_after_seconds` 退避后重试**（单条最多 1–2 次；收到 `503` 熔断响应时暂停向该平台批量发包直至冷却窗口结束）。 |
| `502` | `UPSTREAM_INVALID_RESPONSE` | `false` | 上游返回结构变更或异常非预期载荷 | **不立即循环重试**；记录错误码与 URL 以便排查上游结构变化。 |
| `503` | `SERVICE_NOT_CONFIGURED` | `false` | 目标平台适配器或必需运行组件未在服务端启用（如对未开启服务端提取器的实例调用 YouTube `/api/parse`） | **不重试该平台链接**；先对照 `/api/platforms` 检查实例能力。 |
| `500` | `INTERNAL_ERROR` | `false` | 服务端内部异常 | **不紧循环重试**；最多间隔数秒重试 1 次，仍为 `500` 则中止或跳过并告警。 |

---

## 6. 并发控制、服务端排队、缓存与直链 TTL

### 6.1 按密钥隔离并发池、非队头阻塞慢解析上限与服务端排队

通过 `Authorization: Bearer <token>` 验证的请求按命中的 API 密钥进入各自独立的执行池（`keyPool`），不仅与匿名公网流量（`fast`、`resolve`、`slow`、`catalog` 等限流池）完全隔离，不同 `agent` / `friend` / `owner` 密钥之间也互不抢占配额：

- **角色默认容量与上限**（完整参数范围见 [docs/CONFIGURATION.md](CONFIGURATION.md)）：
  - **`owner` 角色**（含隐式 `DOKITOOL_OWNER_TOKEN`）：默认总并发 `DOKITOOL_OWNER_CONCURRENCY = 8`（`1..32`），`slow_concurrency = 0`（共享总并发），不限速率（`rps = 0`），FIFO 队列 `DOKITOOL_OWNER_QUEUE_SIZE = 256`（`0..4096`），最长等待 `DOKITOOL_OWNER_QUEUE_WAIT = 60s`（`0s..120s`）。
  - **`agent` 角色**：默认总并发 `4`（`1..32`），慢解析子并发 `slow_concurrency = 1`（`0..24`），速率 `rps = 5.0`、`burst = 16`，队列容量 `128`，最长等待 `45s`。
  - **`friend` 角色**：默认总并发 `2`（`1..16`），慢解析子并发 `slow_concurrency = 1`（`0..16`），速率 `rps = 1.0`、`burst = 6`，队列容量 `16`，最长等待 `15s`。
- **非队头阻塞（Non-HOL-Blocking）慢解析子并发**：当某密钥的 `slow_concurrency` 已被海外 `yt-dlp` 慢解析请求占满、但总 `concurrency` 仍有空闲槽位时，后续到达的抖音、哔哩哔哩等纯 Go 快解析请求**不会**被队列前方的慢解析请求阻塞，而是直接获槽执行。
- **排队与 `429` 触发条件**：当未命中缓存的请求超出该密钥的令牌桶速率（`rps > 0` 时），或队列已满、或在队列中等待超过 `queue_wait` 仍未获槽时，服务端返回 HTTP `429`（携带 `Retry-After` 头与 `error.retry_after_seconds`）。
- **客户端超时配置建议**：单次解析本身最长耗时预算为 `45s`。若客户端发起的并发数可能超过所持密钥的 `concurrency` 上限，建议将客户端对 `/api/parse` 的 HTTP 读取超时设为 **`45s + queue_wait + 10s` 余量**（例如 `owner` 默认 `60s` 排队时设为 **`90s–115s`**），避免请求在服务端队列中正常排到槽位前被客户端提前断开（断开会记入 `/api/stats` 对应密钥的 `canceled`）。

### 6.2 下游共享资源与推荐客户端并发度

虽然 `owner` 准入池默认允许 `8` 并发，但部分平台在后端内部仍受物理下游资源约束，建议按平台类型控制客户端并发：

| 目标平台类型 | 后端执行路径与共享资源约束 | 推荐客户端解析并发 |
| --- | --- | --- |
| **抖音（`douyin`）、哔哩哔哩（`bilibili`）** | 纯 Go 解析；若开启上海 `pull` 模式（哔哩哔哩需同时在主后端显式开启 `DOKITOOL_SHANGHAI_BILIBILI`），上海 `shanghai-resolver` 默认运行 `3` 个出站 worker。当全部上海 worker 忙碌时，主后端最多等待 **`300ms`**，未获认领或超时即无阻塞回退日本主后端解析结果（仍返回可用直链，但可能少国内 `*.douyinvod.com` 或 `cn-*.bilivideo.com` 候选）。 | 追求最高吞吐：**`<= 8`**；<br>追求最高上海国内线路命中率：**`<= 3`**（或配合调高 `shanghai-resolver -workers`）。 |
| **X（`x`）常规图文与视频推文** | 默认优先走纯 Go 官方 Syndication 快路径（无需拉起 `yt-dlp` 子进程）；仅在 Syndication 未命中或需回退时才请求 `yt-dlp` 槽位。 | **`4–8`**（若大批链接含需回退的复杂推文，建议降至 **`1–2`**）。 |
| **快手、小红书、皮皮虾等纯 Go 平台** | 纯 Go 无状态抓取与探测，无子进程开销。 | **`4–8`**（建议不超过 `DOKITOOL_OWNER_CONCURRENCY`）。 |
| **Instagram、Facebook、Tumblr** | 每次未命中缓存的解析均需申请社交慢解析舱（`PARSE_SLOW`）的 `yt-dlp` 子进程并发槽位（默认 `4`，通过 `DOKITOOL_YTDLP_CONCURRENCY` / `runtime.json` 调整，与 YouTube / 通用长尾分舱隔离）。 | **`<= 2–4`**（建议结合当前分舱并发留出余量，避免长时间占满全部社交提取器槽位）。 |
| **第二级通用具名提取器长尾站点（`DOKITOOL_YTDLP_GENERIC_ENABLED`）** | 独立隔离的 `PARSE_GENERIC` 准入池与 `DOKITOOL_YTDLP_GENERIC_CONCURRENCY` 并发上限（默认 `2`，与核心快/慢池隔离；认证密钥同时受自身 `slow_concurrency` 约束）；成功缓存 TTL 上限 `60s`。 | **`1`**（长尾站点响应耗时波动较大，建议低并发串行或小批量提交）。 |

> **提示**：解析与 CDN 媒体文件下载可以流水线解耦——例如保持 `4` 个并发协程调用 `/api/parse`，拿到直链后立即交给 `4–8` 个独立的 CDN 下载协程流式落盘。

### 6.3 服务端短时解析缓存（`DOKITOOL_PARSE_CACHE`）与零槽位缓存快路径

- **默认启用**：主后端内置上限为 `4096` 条、`64 MiB` 的并发读锁（`RWMutex`）LRU 结果缓存及同键并发请求合并（`singleflight`）。相同 `(route, platform, normalized_url, item_id, debug)` 的并发或短时重复请求只会访问一次上游平台。
- **鉴权后零槽位缓存快路径（Post-Auth Zero-Slot Cache Fast-Path）**：携带有效 Bearer 密钥请求 `GET /api/parse` 或 `GET /api/resolve` 时，若目标平台通过该密钥的 `platforms` 白名单校验、未被 `disabled_platforms` 手动禁用且进程内缓存存在未过期条目，服务端仅校验该密钥的快读速率桶（`rps > 0` 时为 `max(rps*4, 20.0)` / `max(burst*4, 64)`；`rps == 0` 不限速），在纯读锁下直接返回缓存响应并累加该密钥的 `cache_hits`，**占用 `0` 个 `keyPool` 并发槽位**——即使该密钥的全部并发槽位正被慢上游解析占满，新鲜缓存命中仍能毫秒级即时返回。
- **动态 TTL（核心平台 `10s..600s`、YouTube 默认 `120s`、第二级通用长尾上限 `60s`）**：
  - 若响应内包含任何 `expires_at`，核心平台新鲜缓存寿命取 **`min(600s, earliest_expires_at - now - 60s)`**（YouTube 服务端 `/api/parse` 额外受 `cache.youtube_parse_ttl` 默认 **`120s`** 封顶，设为 `0s` 可关闭；第二级通用具名提取器额外封顶在 **`60s`**）；若扣除 `60s` 安全余量后不足 `10s`，则不写入缓存，确保缓存绝不返回即将过期的直链。
  - 若响应不含 `expires_at`，核心平台成功响应默认缓存 **`300s`**（仍受上述平台上限约束）。
  - **`stale-if-error` 过期兜底**：当实时回源遭遇上游/系统故障（`UPSTREAM_TIMEOUT` / `UPSTREAM_UNAVAILABLE` / `UPSTREAM_INVALID_RESPONSE` / `INTERNAL_ERROR` 或可重试 `RATE_LIMITED`）或平台自动熔断打开时，若存在未超过 `cache.stale_if_error_ttl`（默认 `600s`）且严格早于 **`earliest_expires_at - 15s`** 硬顶的历史成功条目，服务端返回该兜底响应并附加 `X-DokiTool-Cache: stale`；人工配置的 `disabled_platforms` 紧急下线不走缓存兜底，直接返回 `503`。
  - 负缓存：`404 CONTENT_UNAVAILABLE` 缓存 **`10s`**，`403 UPSTREAM_BLOCKED` 缓存 `cache.upstream_blocked_neg_ttl`（默认 **`5s`**，置 `0s` 关闭）；负缓存绝不作为 `stale` 兜底返回，其他 `429`/`5xx` 错误不写入缓存。
  - `weibo` 现已统一走零中转 `PreparePublic` 直链并接入进程内解析缓存与 `singleflight` 合并；`youtube` 仅在 `cache.youtube_parse_ttl = 0s` 时记为 `uncacheable`。
- HTTP 响应头始终保持 `Cache-Control: no-store`，防止反向代理或客户端 HTTP 缓存组件在进程外把签名直链缓存过久。

### 6.4 CDN 直链有效期（`expires_at`）与即时下载原则

第三方平台返回的媒体 CDN 直链普遍带有时效签名（`expires_at` 常见在数分钟到 1–2 小时之间，部分平台甚至不在 URL 中暴露显式过期时间）。因此：

- **禁止「先全量解析、数小时后再下载」**：切勿先把几百上千条分享链接一次性跑完 `/api/parse` 存成 JSON，隔很久再去拉取 CDN 字节——届时大批直链会返回 HTTP `403` 或 `410`。
- **采用「解析一条、立即流式下载一条」的流水线**：每条作品拿到 `/api/parse` 结果后立即启动 CDN 下载；若下载中途因大文件耗时长导致 CDN 返回 `403` / `410`，最多对该作品重新调用 **1 次** `/api/parse` 获取新签名 URL 后续传或重下。
