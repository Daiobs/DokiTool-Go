# Agent 接口调用指南（Personal Agent Channel）

本文档面向命令行脚本、后台任务与自动化 Agent，说明如何使用私有令牌（`DOKITOOL_OWNER_TOKEN`）调用 DokiTool 统一媒体 v1（`schema_version=1.0`）接口完成高吞吐解析、状态观测与直链提取。

- 完整的批量下载工程实践与标准库可运行示例脚本见 [docs/AGENT-BATCH-DOWNLOAD.md](AGENT-BATCH-DOWNLOAD.md) 与 [examples/agent_batch_download.py](../examples/agent_batch_download.py)。
- 机器可读 OpenAPI `3.1.0` 契约见 [docs/openapi.json](openapi.json)；底层 JSON Schema 真值见 [docs/schema/unified-v1/unified-v1.schema.json](schema/unified-v1/unified-v1.schema.json)。

---

## 1. 适用范围与平台边界

### 1.1 主支持范围（Agent 批量直下目标）

个人 Agent 通道的核心设计目标是**抖音（`douyin`）、X（`x`）及其他返回公开 CDN 直链的平台**（如快手 `kuaishou`、哔哩哔哩 `bilibili`、小红书 `xiaohongshu`、今日头条 `toutiao`、皮皮虾 `pipixia`、皮皮搞笑 `pipigx`、最右图片 `zuiyou`、Instagram `instagram`、Facebook `facebook`、Tumblr `tumblr`）。这些平台的媒体字节由客户端直接向平台 CDN 拉取，服务端仅负责解析与统一契约输出，不中转任何媒体流量。

### 1.2 不在主批量范围内的平台

以下两个平台**不在 Agent 批量下载主支持范围内**：

1. **YouTube（`youtube`）**：
   - 线上标准产品路径依赖桌面浏览器端同源用户脚本（`DokiTool YouTube Helper`），由浏览器直接请求 `www.youtube.com` 获取流清单并通过 `/api/youtube/context` + `/api/youtube/finalize` 完成签名解算与浏览器内 Mediabunny 无损音视频合并（前端在未检测到用户脚本时合成客户端级 `HELPER_REQUIRED` 提示状态）。
   - 在默认未开启 `DOKITOOL_YTDLP_YOUTUBE_ENABLED` 的服务端上，对 YouTube 链接调用 `GET /api/parse` 会直接返回 HTTP `503`（`code: "SERVICE_NOT_CONFIGURED"`）；即便在自建实例上开启服务端提取器，`*.googlevideo.com` 媒体直链通常绑定服务端出口 IP，异地客户端直连下载仍会被拒绝。Agent 批量任务应在输入阶段直接过滤或跳过 YouTube 链接。
2. **微博（`weibo`）**：
   - 微博不在主批量支持范围内：DokiTool 注册的微博能力仅为 `["video"]`（不支持纯图片微博图文提取；非视频微博状态帖会返回 `404 CONTENT_UNAVAILABLE` 或因上游状态接口访客限制返回 `403 UPSTREAM_BLOCKED`），且微博响应不进入服务端短时解析缓存。
   - **携带有效 Owner Token 解析微博时的精确服务端行为**：与匿名网页访客返回本站 `/api/media/weibo?ticket=...` 同源中转票据不同，携带有效 `DOKITOOL_OWNER_TOKEN` 调用 `/api/parse` 解析公开微博视频（例如 `https://weibo.com/tv/show/1034:...`）时，服务端走 `PrepareOwner` 分支，**不签发任何本站中转票据**，而是直接返回原始 CDN 直链（视频流位于 `f.video.weibocdn.com`，封面与头像位于 `*.sinaimg.cn`，`access` 省略即 `"direct"`）。
   - **直连下载微博原始 CDN 链接的 `Referer` 实测要求**：微博音视频与图片 CDN 均校验 `Referer` 防盗链。若客户端确需直连下载返回的 `*.weibocdn.com` 或 `*.sinaimg.cn` 原始直链，**必须附带请求头 `Referer: https://weibo.com/`（无需且不应携带任何 `Cookie`，严禁转发 `Authorization` 头）**。对公开微博视频帖与图片帖原始 CDN 直链执行只读 `Range: bytes=0-1023` 的实测结果如下：

     | 资源类型 | 原始 CDN 主机名 | Case A：无 `Referer`、无 `Cookie` | Case B：`Referer: https://weibo.com/`、无 `Cookie` |
     | --- | --- | --- | --- |
     | 公开微博视频流（`PrepareOwner` 返回） | `f.video.weibocdn.com` | HTTP `403` | HTTP `206`（`video/mp4`） |
     | 公开微博视频封面（`PrepareOwner` 返回） | `wx4.sinaimg.cn` | HTTP `403` | HTTP `206`（`image/jpeg`） |
     | 公开微博图片帖原图（图片 CDN 直测） | `wx2.sinaimg.cn` / `wx3.sinaimg.cn` | HTTP `403` | HTTP `206`（`image/jpeg`） |

---

## 2. 认证方式与鉴权安全规则

### 2.1 读取与传递令牌

服务端通过环境变量 `DOKITOOL_OWNER_TOKEN` 配置个人通道令牌（留空表示关闭个人通道；非空时须为 `32–512` 字节、不含空白或控制字符的可打印 ASCII 字符串，服务端仅在内存中保存其 SHA-256 摘要并执行常量时间比对）。

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
- **严禁放入 URL 查询参数**：服务端仅从 `Authorization` 请求头读取令牌。在 `/api/parse`、`/api/resolve`、`/api/platforms` 中，查询参数里的令牌（如 `?token=...`、`?owner_token=...`）会被忽略，请求按**匿名访客**处理（例如未命中缓存的匿名 `/api/parse` 受单 IP `Burst=4`、`0.2/s` 限流，纯 Go 平台的匿名 `/api/resolve` 走独立的 `Resolve` 池〔单 IP `Burst=12`、`0.5/s`、并发 `2`〕，命中进程内新鲜缓存的 `/api/parse` 与 `/api/resolve` 走轻量的 `Catalog` 池，且微博返回中转票据），**不会报错提醒**（仅 `GET /api/stats` 会在缺少请求头时返回 `401`、在已带有效请求头时拒绝多余的查询参数并返回 `400 INVALID_INPUT`）；同时查询参数里的令牌还会暴露在日志和终端历史里。
- **严禁向第三方 CDN 转发凭据**：`/api/parse` 与 `/api/resolve` 返回的媒体 URL 指向抖音、X 等第三方平台 CDN。下载媒体字节时**绝对禁止携带 `Authorization` 头或任何 `Cookie`**。

### 2.2 鉴权失败的精确行为（HTTP `401` 与防暴力限流 `429`）

> **关键行为（客户端必须特殊处理）**：
> 当请求附带了 `Authorization` 头（或在强制要求鉴权的 `GET /api/stats` 上缺失 `Authorization` 头），且出现以下任一情形时：
> 1. 令牌内容错误（与服务端 `DOKITOOL_OWNER_TOKEN` 不匹配）；
> 2. 格式畸形（非 `"Bearer "` 前缀、空令牌、含空白字符或非可打印 ASCII 字节）；
> 3. `Authorization` 请求头长度超过 **`1024` 字节**，或同一请求发送了多个 `Authorization` 头；
> 4. 服务端未配置或已关闭个人通道（`DOKITOOL_OWNER_TOKEN` 为空）；
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

**Agent 实现铁律**：判断错误类型时**必须优先检查 HTTP 状态码是否为 `401`**，不能只看 JSON 里的 `code == "INVALID_INPUT"`。收到 HTTP `401` 代表令牌配置错误或服务端未开启个人通道，Agent 必须**立即终止整个批处理任务并告警**，切勿将其当作单条分享链接格式错误跳过并继续请求后续 URL。

---

## 3. 接口参考

所有接口响应均设置 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。在 `/api/parse`、`/api/resolve` 与 `/api/platforms` 中，未定义的额外查询参数（包括误放在 `?token=...` 中的令牌）会被直接忽略且不会报错；只有 `GET /api/stats`（通过请求头鉴权后）会拒绝除可选 `schema_version` 外的多余查询参数或末尾裸 `?` 并返回 HTTP `400 INVALID_INPUT`。

### 3.1 `GET /api/parse` — 解析分享链接或分享口令文本

- **认证**：可选 `Authorization: Bearer $DOKITOOL_OWNER_TOKEN`（推荐 Agent 始终携带以进入独立 `owner` 并发池；不带时命中进程内新鲜缓存走轻量的 `Catalog` 池，未命中缓存走匿名快/慢解析池限流）。
- **查询参数**：
  | 参数名 | 必填 | 约束与说明 |
  | --- | --- | --- |
  | `schema_version` | **是** | 固定为 `"1.0"`。缺失、数组形式（如 `schema_version[]=`）或值不等于 `"1.0"` 时返回 HTTP `409`（`code: "INVALID_INPUT"`）。 |
  | `url` | **是** | 作品分享链接或包含单个 `http(s)` 链接的分享口令文本（整体长度 `<= 8192` 字节；海外 `yt-dlp` 平台提取出的 URL 长度 `<= 2048` 字节）。服务端自动提取首个 `http(s)` URL 并剥离尾随标点。 |
  | `platform` | 否 | 指定平台 ID（见 `/api/platforms`）或 `"all"`。省略或传 `"all"` 时按 URL 域名自动识别；显式指定时若与链接实际平台不一致则返回 HTTP `400`（`code: "INVALID_INPUT"`）。 |
  | `debug` | 否 | 传 `"1"` 时启用完整规范化诊断视图（保留被默认产品视图折叠的同规格备选 `mux` 等候选）；省略或传其他值均按常规产品视图处理。常规批量下载无需传 `debug=1`。 |

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

- **认证**：可选 `Authorization: Bearer $DOKITOOL_OWNER_TOKEN`（Agent 调用时应继续携带同一请求头以进入 `owner` 池；不带时命中进程内新鲜缓存走轻量的 `Catalog` 池，未命中缓存时纯 Go 平台走独立的 `Resolve` 池〔单 IP `Burst=12`、`0.5/s`、并发 `2`〕，海外慢解析平台走慢解析池）。
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

- **认证**：可选 `Authorization: Bearer $DOKITOOL_OWNER_TOKEN`（携带有效令牌时走 `owner` 池；不带时走 `CATALOG` 池）。
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

提供当前 `dokitool` 进程自启动以来的请求计数、缓存命中率、`fast` / `slow` / `owner` 三池排队与拒绝计数、`yt-dlp` 并发槽位等待直方图、抖音上海通道工作状态及端到端解析耗时直方图。仅统计聚合计数器，不含任何 URL、IP 或令牌内容。

- **认证**：**强制要求** `Authorization: Bearer $DOKITOOL_OWNER_TOKEN`。缺失、错误、格式畸形、超长（`> 1024` 字节）、重复 `Authorization` 头或服务端未配置 `DOKITOOL_OWNER_TOKEN` 时，均扣减匿名单 IP 配额并返回 HTTP `401`（`code: "INVALID_INPUT"`，连续失败第 5 次起返回 HTTP `429`）。**通过鉴权的 `/api/stats` 请求不占用 `owner` 并发槽位，也不计入 `requests` 解析统计**。
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
          "misses": 100,
          "singleflight_shared": 4,
          "uncacheable": 0
        },
        "by_channel": {
          "anonymous": {
            "hits": 6,
            "misses": 20,
            "singleflight_shared": 2,
            "uncacheable": 0
          },
          "owner": {
            "hits": 18,
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
          "concurrency_limit": 2,
          "queue_limit": 32,
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
      }
    }
  }
  ```
- **核心统计字段说明**：
  - `requests.by_platform_code_channel[*]`：仅输出 `count > 0` 的非零组合，按 `(platform, code, channel)` 稳定排序。`platform` 为 14 个内置平台 ID 加 `"unknown"`（共 15 个闭合枚举）；`code` 为 `"OK"`、11 个公开契约错误码及内部鉴权拒绝码 `"UNAUTHORIZED"`（共 13 个闭合枚举）；`channel` 为 `"anonymous"` 或 `"owner"`。
  - `admission.{fast,slow,owner}`：`active` 为当前正在执行的请求数，`queued` 为当前在 FIFO 队列等待的请求数，`waited` / `granted` / `timeout` / `full` / `canceled` 为累计入队、获槽、等待超时（`429`）、队列满拒绝（`429`）与客户端中途断开计数。
  - `shanghai`：`mode` 为 `"off"` / `"direct"` / `"pull"`；`pull` 模式下 `waiting_workers` 反映当前空闲待命的上海 `shanghai-resolver` 工作协程数，`hits` 与 `fallbacks` 反映上海国内线路命中与回退本地解析次数，`by_platform.{douyin,bilibili}` 按平台分别统计抖音与哔哩哔哩的上海通道命中、排队与回退次数（哔哩哔哩上海通道受主后端独立开关 `DOKITOOL_SHANGHAI_BILIBILI` 控制，默认关闭时 `by_platform.bilibili` 各项保持为 `0`）。
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
   - **更高画质分离轨道（`item.higher_quality_variants[*]`）**：当某平台（如哔哩哔哩高码率 DASH）存在比最高完整单文件 `file` 分辨率更高的音视频分离版本时，`item.default` 仍指向可直接单文件下载的最高完整 `file`，而 `item.higher_quality_variants` 会列出 `requires: ["mux"]` 的 `variant_id`。仅当 Agent 本地具备 `ffmpeg` 无损混流步骤时才选择 `delivery.kind == "mux"` 的版本。

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
| **`401`** | `INVALID_INPUT` | `false` | `Authorization` 令牌错误、格式非法、超长（`> 1024 B`）、重复发送，或服务端未配置 `DOKITOOL_OWNER_TOKEN`（每次失败还会扣减单 IP 突发配额） | **立即中止整批任务并告警**；检查环境变量 `$DOKITOOL_OWNER_TOKEN` 与目标服务端配置，**严禁重试或继续遍历后续 URL**。 |
| `400` / `405` / `409` / `410` | `INVALID_INPUT` | `false` | 缺少/非法 `url` 或 `item_id`、`/api/stats` 携带未知查询参数、`platform` 与链接不匹配、抖音合集 `mix_id`、小红书缺失 `xsec_token`、Facebook `fb.watch` 短链、`schema_version` 不匹配（`409`）、方法错误（`405`）、旧路径退役（`410`） | **不重试**；将该条输入标记为永久输入错误（`failed_permanent`）并继续处理下一条 URL。 |
| `400` | `UNSUPPORTED_PLATFORM` | `false` | 链接域名不在支持目录（如 `t.co`、`instagr.am` 短链或未接入网站），或目标平台在当前实例未启用 | **不重试**；标记为不支持平台并跳过。 |
| `404` | `NO_MEDIA` | `false` | 帖子公开存在但不含受支持媒体（如 X 纯文本推文、仅含不受支持流格式的作品） | **不重试**；标记为无媒体作品并跳过。 |
| `404` | `CONTENT_UNAVAILABLE` | `false` | 作品已删除、不存在，或请求的 `item_id` 不存在（服务端会负缓存 `10s`） | **不重试**；标记为作品不可用并跳过。 |
| `403` | `UPSTREAM_BLOCKED` | `false` | 作品私密、年龄受限、需登录查看（如 Instagram Stories、私密帖、未开回退的 X 受限推文）或触发上游页面风控 | **不在紧循环中重试**；标记为受限/风控阻塞并跳过。 |
| **`429`** | `RATE_LIMITED` | `true` | `owner` 等待队列已满或排队满 `60s` 超时、上游平台返回 `429`，或鉴权失败累计触发单 IP 限流 | **退避后重试**（单条最多 2–3 次）：优先读取 `error.retry_after_seconds` 或 HTTP `Retry-After` 头（默认至少等待 `1s`）并加少量随机抖动；若此前曾发过无效 token，先排查鉴权配置。 |
| `504` | `UPSTREAM_TIMEOUT` | `true` | 上游平台页面/API 在解析预算内超时 | **有限指数退避重试**（最多 1–2 次，例如等待 `2s` -> `5s`），仍失败则记入失败清单留待后续人工或低峰补跑。 |
| `502` | `UPSTREAM_UNAVAILABLE` | `true` | 上游接口暂时不可用或外部提取器瞬态错误 | **有限指数退避重试**（最多 1–2 次，等待 `2s` -> `5s`）。 |
| `502` | `UPSTREAM_INVALID_RESPONSE` | `false` | 上游返回结构变更或异常非预期载荷 | **不立即循环重试**；记录错误码与 URL 以便排查上游结构变化。 |
| `503` | `SERVICE_NOT_CONFIGURED` | `false` | 目标平台适配器或必需运行组件未在服务端启用（如对未开启服务端提取器的实例调用 YouTube `/api/parse`） | **不重试该平台链接**；先对照 `/api/platforms` 检查实例能力。 |
| `500` | `INTERNAL_ERROR` | `false` | 服务端内部异常 | **不紧循环重试**；最多间隔数秒重试 1 次，仍为 `500` 则中止或跳过并告警。 |

---

## 6. 并发控制、服务端排队、缓存与直链 TTL

### 6.1 个人通道并发池与服务端排队机制

通过 `Authorization: Bearer $DOKITOOL_OWNER_TOKEN` 验证的 `/api/parse`、`/api/resolve` 与 `/api/platforms` 请求进入独立的 `owner` 准入池，与匿名公网流量（`fast`、`resolve`、`slow`、`catalog` 等限流池）完全隔离：

- **默认容量与上限**：
  - 最大同时在途请求数 `DOKITOOL_OWNER_CONCURRENCY`：默认 **`8`**（可配置范围 `1..32`）。
  - 内存 FIFO 等待队列容量 `DOKITOOL_OWNER_QUEUE_SIZE`：默认 **`256`**（可配置范围 `0..4096`）。
  - 单请求最长排队等待时间 `DOKITOOL_OWNER_QUEUE_WAIT`：默认 **`60s`**（可配置范围 `0s..120s`）。
- **排队与 `429` 触发条件**：当正在执行的个人请求达到 `DOKITOOL_OWNER_CONCURRENCY` 时，新到达的个人请求不会立即报错，而是进入 FIFO 队列按到达顺序等待空槽。只有当**队列已满（`queued >= 256`）**或**请求在队列中等待满 `60s` 仍未获槽**时，服务端才会返回 HTTP `429`（`Retry-After: 1`，`error.retry_after_seconds: 1`）。
- **客户端超时配置建议**：单次解析本身最长耗时预算为 `45s`。若客户端发起的并发数可能超过 `DOKITOOL_OWNER_CONCURRENCY`，建议将客户端对 `/api/parse` 的 HTTP 读取超时设为 **`90s–115s`**，避免请求在服务端队列中正常排到槽位前被客户端提前断开（断开会记入 `/api/stats` 的 `admission.owner.canceled`）。

### 6.2 下游共享资源与推荐客户端并发度

虽然 `owner` 准入池默认允许 `8` 并发，但部分平台在后端内部仍受物理下游资源约束，建议按平台类型控制客户端并发：

| 目标平台类型 | 后端执行路径与共享资源约束 | 推荐客户端解析并发 |
| --- | --- | --- |
| **抖音（`douyin`）、哔哩哔哩（`bilibili`）** | 纯 Go 解析；若开启上海 `pull` 模式（哔哩哔哩需同时在主后端显式开启 `DOKITOOL_SHANGHAI_BILIBILI`），上海 `shanghai-resolver` 默认运行 `3` 个出站 worker。当全部上海 worker 忙碌时，主后端最多等待 **`300ms`**，未获认领或超时即无阻塞回退日本主后端解析结果（仍返回可用直链，但可能少国内 `*.douyinvod.com` 或 `cn-*.bilivideo.com` 候选）。 | 追求最高吞吐：**`<= 8`**；<br>追求最高上海国内线路命中率：**`<= 3`**（或配合调高 `shanghai-resolver -workers`）。 |
| **X（`x`）常规图文与视频推文** | 默认优先走纯 Go 官方 Syndication 快路径（无需拉起 `yt-dlp` 子进程）；仅在 Syndication 未命中或需回退时才请求 `yt-dlp` 槽位。 | **`4–8`**（若大批链接含需回退的复杂推文，建议降至 **`1–2`**）。 |
| **快手、小红书、皮皮虾等纯 Go 平台** | 纯 Go 无状态抓取与探测，无子进程开销。 | **`4–8`**（建议不超过 `DOKITOOL_OWNER_CONCURRENCY`）。 |
| **Instagram、Facebook、Tumblr** | 每次未命中缓存的解析均需申请全局共享的 `DOKITOOL_YTDLP_CONCURRENCY` 子进程信号量（默认 `2`，可配置范围 `1..24`）。 | **`<= 1–2`**（默认配置下建议 `1`，留出余量避免长时间占满全部提取器槽位）。 |

> **提示**：解析与 CDN 媒体文件下载可以流水线解耦——例如保持 `4` 个并发协程调用 `/api/parse`，拿到直链后立即交给 `4–8` 个独立的 CDN 下载协程流式落盘。

### 6.3 服务端短时解析缓存（`DOKITOOL_PARSE_CACHE`）

- **默认启用**：主后端内置上限为 `4096` 条、`64 MiB` 的 LRU 结果缓存及同键并发请求合并（`singleflight`）。相同 `(route, platform, normalized_url, item_id, debug)` 的并发或短时重复请求只会访问一次上游平台。
- **动态 TTL（`10s..180s`）**：
  - 若响应内包含任何 `expires_at`，缓存寿命取 **`min(180s, earliest_expires_at - now - 60s)`**；若扣除 `60s` 安全余量后不足 `10s`，则不写入缓存，确保缓存绝不返回即将过期的直链。
  - 若响应不含 `expires_at`，成功响应缓存 **`60s`**。
  - `404 CONTENT_UNAVAILABLE` 负缓存 **`10s`**；`429`、`5xx` 及其他错误不缓存。
  - **`weibo` 与 `youtube` 永久不缓存且不合并**（在 `/api/stats` 中计入 `cache.by_channel.*.uncacheable`）。
- HTTP 响应头始终保持 `Cache-Control: no-store`，防止反向代理或客户端 HTTP 缓存组件在进程外把签名直链缓存过久。

### 6.4 CDN 直链有效期（`expires_at`）与即时下载原则

第三方平台返回的媒体 CDN 直链普遍带有时效签名（`expires_at` 常见在数分钟到 1–2 小时之间，部分平台甚至不在 URL 中暴露显式过期时间）。因此：

- **禁止「先全量解析、数小时后再下载」**：切勿先把几百上千条分享链接一次性跑完 `/api/parse` 存成 JSON，隔很久再去拉取 CDN 字节——届时大批直链会返回 HTTP `403` 或 `410`。
- **采用「解析一条、立即流式下载一条」的流水线**：每条作品拿到 `/api/parse` 结果后立即启动 CDN 下载；若下载中途因大文件耗时长导致 CDN 返回 `403` / `410`，最多对该作品重新调用 **1 次** `/api/parse` 获取新签名 URL 后续传或重下。
