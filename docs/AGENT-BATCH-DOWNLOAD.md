# Agent 批量下载最佳实践指南

本文档说明如何基于 DokiTool 个人 Agent 通道（[docs/AGENT-API.md](AGENT-API.md)）构建稳定、可断点恢复且对服务端与上游 CDN 友好的批量媒体下载流水线，并配套提供零外部依赖的 Python 3 标准库参考脚本 [examples/agent_batch_download.py](../examples/agent_batch_download.py)（如需单条交互式解析、字幕提取或 AI MCP 工具接入，请优先使用 [tools/dokitool-agent](../tools/dokitool-agent/README.md)）。

---

## 1. 平台范围与前置检查

### 1.1 目标平台边界

- **主支持范围**：**抖音（`douyin`）**、**X（`x`）** 以及快手、哔哩哔哩、小红书、今日头条、皮皮虾、皮皮搞笑、最右图片、Instagram、Facebook、Tumblr 等返回公开 CDN 直链的平台。
- **不在主批量范围内的平台**：
  1. **YouTube（`youtube`）**：标准产品方案统一使用 **Chrome MV3 原生扩展（`v4.5.2`）**（纯 Web 端未安装扩展时展示 `HELPER_REQUIRED` 引导安装）；默认未启用服务端提取器时调用 `/api/parse` 返回 `503 SERVICE_NOT_CONFIGURED`，且 `*.googlevideo.com` 流地址通常绑定请求出口 IP，**切勿将 YouTube 链接混入 `/api/parse` 批处理列表**。
  2. **微博（`weibo`）**：不在主批量范围内（仅支持视频能力 `["video"]`，纯图片微博帖返回 `404 CONTENT_UNAVAILABLE` 或受上游访客风控返回 `403 UPSTREAM_BLOCKED`，且结果不入服务端缓存）。若携带有效 `DOKITOOL_OWNER_TOKEN` 解析公开微博视频，服务端会跳过 `/api/media/weibo?ticket=...` 同源中转票据签发，直接返回 `f.video.weibocdn.com` 与 `*.sinaimg.cn` 原始直链；客户端直连下载此类域名时**必须设置请求头 `Referer: https://weibo.com/`（不带 `Cookie`，严禁带 `Authorization`）**——实测无 `Referer` 时返回 HTTP `403`，附带 `Referer: https://weibo.com/`（无 `Cookie`）时返回 HTTP `206`。

### 1.2 输入清单预处理建议

在将链接送入 `/api/parse` 前，建议先在本地完成轻量清洗：
- 去除空行、`#` 注释行与完全重复的输入行；
- 提前过滤掉 `youtube.com` / `youtu.be` 链接，以及平台明确不支持的链接形式（如指向外部非推文页的 `t.co` 短链、需登录展开的 `fb.watch` 短链、抖音 `mix_id` 合集页）；
- 读取已完成清单（`manifest.jsonl`），跳过 `status == "ok"` 的历史已完成项，实现幂等续跑。

---

## 2. 标准六步流水线架构

```text
URL 清单 (urls.txt)
   │  跳过 manifest.jsonl 中已成功的输入
   ▼
[1] 即时解析  GET /api/parse?schema_version=1.0&url=...  (Header: Authorization: Bearer $DOKITOOL_OWNER_TOKEN)
   │  若条目 state == "deferred"，继续调用 item.resolve_url (GET /api/resolve)
   ▼
[2] 候选路由提取  读取 item.default 对应 variant 的 sources[*] + fallback_urls[*]（Live Photo 读取 pair 双资源）
   │  过滤 availability=="unavailable" 与已临近 expires_at 的过期地址
   ▼
[3] 线路择优与切换  默认从首选线路直连（遇 403/5xx 切下一候选）；大文件可选首段 256 KiB Range 测速
   ▼
[4] 流式写入临时文件  写入 <stem>.part（支持 Range: bytes=<offset>- 断点续传，区分 206 与 200）
   ▼
[5] 完整性校验  核对落盘字节数与 source.size_bytes（或 Content-Length / Content-Range 总长度）一致
   ▼
[6] 扩展名判定与原子落盘  按「结果字段 → Content-Type → 文件头特征字节 → .bin」定稿后缀，os.replace(<stem>.part, <stem>.<ext>) 并记入 manifest.jsonl
```

**核心设计要点**：**「解析一条、立即下载一条」**。每个工作协程在同一生命周期内完成单条 URL 的解析与 CDN 落盘，避免先把成百上千个签名直链攒在内存里导致后半程直链大面积过期。

---

## 3. 重点平台直连下载细节

### 3.1 抖音（`douyin`）：多线路候选、测速与 `403` 切换

抖音视频（尤其是经上海 `pull` 通道合并后的 `1080p` / `2160p` 原画）通常在单个 `variant.delivery.sources[*]` 中同时携带多条国内 `*.douyinvod.com` 节点与源站节点，且单条 `source` 内还可能带有同源备用签名参数列表 `fallback_urls[*]`：

1. **构建有序候选队列**：
   - 将 `item.default.source_id` 指定的 `source` 排在首位，其余 `availability != "unavailable"` 的 `source` 紧随其后；
   - 对每个未过期的 `source`（检查 `expires_at - now > 30s`），按 `[source.url, *source.fallback_urls]` 顺序展开并去重。
2. **两种选路模式**：
   - **顺序故障切换（默认推荐，零额外探测开销）**：直接请求首选 URL；若某节点因地域调度或签名差异返回 HTTP `403` / `5xx` / 连接超时，立即切换候选队列中的下一条 URL。
   - **首段吞吐测速（适合大体积 4K 原画，`--probe-routes`）**：对前 2–3 条不同 `source` 发送 `Range: bytes=0-262143`（256 KiB，超时 `8s`），跳过非 `200`/`206` 节点，按实测字节吞吐率（`bytes / elapsed`）降序重排后再拉取全量文件。
3. **图文与实况照片（Live Photo）**：
   - 抖音图文作品的 `data.items[*]` 包含多张图片或实况条目，必须逐项遍历下载；
   - 当 `item.type == "live_photo"` 时，`item.default` 为 `null`，需从 `variant.delivery`（`kind: "pair"`）的 `resources[*]` 中分别提取 `role: "image"`（静图）与 `role: "motion"`（动态视频片段）各自落盘。

### 3.2 X（`x`）：高清原图与多码率 MP4 视频

- **解析路径**：服务端对普通公开推文优先走纯 Go 官方 Syndication 快路径（毫秒至百毫秒级响应，不占 `yt-dlp` 进程槽位），自动把分辨率最高的完整有声 MP4 选为 `item.default`。
- **图片推文（`pbs.twimg.com`）**：多图推文（最多 4 图）会在 `data.items` 中生成 `image-1`..`image-4` 多个 `type: "image"` 条目，直接下载各条目的 `item.default.url` 即可拿到高清图片。
- **视频与 GIF 推文（`video.twimg.com`）**：`item.default.url` 指向最高规格 MP4 直链；若需较低码率版本，可在 `item.variants[*]` 中按 `width` / `height` 或 `bitrate_bps` 挑选。单条混合媒体推文可能同时包含图片条目与视频条目，遍历 `data.items[*]` 即可完整保存。
- **无媒体推文**：纯文字推文固定返回 HTTP `404`（`code: "NO_MEDIA"`），属于正常业务结果，记录后直接跳过即可。

---

## 4. 安全文件命名与防覆盖规范

千万不要直接信任上游作品标题或 URL 路径拼出本地路径（标题常含换行、Emoji 组合符、`/`、`\`、`..` 甚至为空）：

1. **推荐确定性主文件名**：
   ```text
   <platform>_<content_id>_<item_id>.<ext>
   # Live Photo 双资源：
   <platform>_<content_id>_<item_id>_image.<ext>
   <platform>_<content_id>_<item_id>_motion.<ext>
   ```
   当上游未返回 `content_id` 时，对 `source_url` 计算 SHA-256 取前 12 位十六进制摘要作为稳定后备 ID。
2. **如需附带可读标题前缀**：
   - 将 `[\\/:*?"<>|\x00-\x1f\x7f]` 与连续空白统一替换为 `_`，剥离首尾 `.` 与空格；
   - **按 Unicode 字符（码位）而非 UTF-8 字节硬切截断**（例如限制 `<= 48` 个字符），避免截断出半个多字节 UTF-8 序列导致文件系统报错，同时为 `.part` 后缀预留充裕长度（避开 `255` 字节文件名上限）；
   - 拦截 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）。
3. **强制目录边界断言**：拼接输出目录后校验 `target_path.resolve().parent == output_dir.resolve()`，彻底杜绝任何路径穿越写入。
4. **扩展名四级判定顺序**（部分平台如抖音解析结果不含 `metadata.extension` / `mime_type`，且 `*.douyinvod.com` 路径无后缀，必须按下述顺序依次判断，避免将完整 MP4 或图片误存为 `.bin`）：
   1. **解析结果里的字段**：依次检查选中 `variant.metadata.extension`、`metadata.mime_type` 映射、`metadata.container`，以及 URL 路径上的已知媒体后缀（如 `.mp4`、`.mov`、`.webm`、`.m4a`、`.mp3`、`.jpg`、`.png`、`.webp`、`.gif`、`.heic`、`.avif`；忽略 `.php` 等非媒体后缀）；
   2. **下载响应的 `Content-Type` 头**：剥离 `; charset=...` 等参数后映射已知媒体 MIME（如 `video/mp4` → `.mp4`、`video/webm` → `.webm`、`video/quicktime` → `.mov`、`audio/mp4` / `audio/x-m4a` → `.m4a`、`audio/mpeg` → `.mp3`、`image/jpeg` → `.jpg`、`image/png` → `.png`、`image/webp` → `.webp`、`image/gif` → `.gif`、`image/avif` → `.avif`）；若返回 `application/octet-stream`、`binary/octet-stream`、`text/plain`、`text/html` 等通用或非媒体类型，则继续向下嗅探；
   3. **文件开头的特征字节（Magic Bytes）**：读取已下载文件起始字节识别容器——ISOBMFF `ftyp`（字节 `4..8` 为 `ftyp`：主品牌 `M4A ` / `M4B ` → `.m4a`、`qt  ` → `.mov`，其余如 `isom` / `mp42` → `.mp4`）、JPEG（`FF D8 FF` → `.jpg`）、PNG（`89 50 4E 47 0D 0A 1A 0A` → `.png`）、WebP（`RIFF....WEBP` → `.webp`）、GIF（`GIF87a` / `GIF89a` → `.gif`）；
   4. **最后兜底 `.bin`**：仅当前三步均无法识别真实格式时，最后才使用 `.bin`。

---

## 5. `.part` 临时文件、`Range` 续传与过期刷新

### 5.1 流式落盘与 `Range` 续传（严格区分 `206` 与 `200`）

1. 下载未完成前一律写入按条目主干命名的同目录临时文件 `<stem>.part`（不依赖最终扩展名），待整包字节校验通过并按上述四级顺序确定最终后缀 `<ext>` 后，再调用 `os.replace(part_path, final_path)` 原子替换为 `<stem>.<ext>`。这样即使进程崩溃或被 `SIGINT` 中断，目标目录中也绝不会出现截断损坏的正式文件，且下次续传仍能稳定定位同一个 `<stem>.part` 并在合并完成后从文件起始处读取完整特征字节。
2. 若启动下载时发现 `<stem>.part` 已存在且大小 `offset > 0`：
   - 若已知 `source.size_bytes` 且 `offset >= size_bytes`，说明旧临时文件异常，先删除 `.part` 并归零 `offset = 0`；
   - 发送 `Range: bytes=<offset>-` 请求头：
     - **服务端返回 HTTP `206 Partial Content`**：校验响应头 `Content-Range: bytes <start>-<end>/<total>` 中的 `<start> == offset`，匹配时以追加模式（`"ab"`）从断点继续写入；
     - **服务端返回 HTTP `200 OK`**（部分 CDN 节点忽略 `Range` 直接重发整包）：**必须以截断覆盖模式（`"wb"`）从字节 `0` 重新写入**，切忌在 `200` 响应下使用追加模式导致文件头部重复拼接损坏！
3. **字节数核验**：下载流读尽后，若 `source.size_bytes` 已知则必须满足 `written_bytes == size_bytes`（否则若响应给出了 `Content-Length` 或 `Content-Range` 总长，也须完全一致），校验通过后再执行原子改名。

### 5.2 直链过期（`403` / `410`）的单次重解析刷新

当下载超大视频或网络较慢导致当前作品的所有候选 CDN 线路均返回 HTTP `403` 或 `410` 时：
- 允许对该输入链接重新调用 **最多 1 次** `/api/parse`（分集条目则重调 `resolve_url`），用新拿到的签名 URL 配合本地已有的 `.part` 执行续传；
- 若单次刷新后新直链仍然返回 `403` / `410`，立即停止重试该条目并记入失败清单，防止陷入死循环。

---

## 6. 重试与退避规则速查

| 阶段与返回信号 | 重试上限 | 退避方式与动作 |
| --- | --- | --- |
| API 返回 **HTTP `401`**（`code: "INVALID_INPUT"`） | **`0` 次（整批急停）** | 通知所有工作协程立即停止后续请求并以非零状态码退出，防止连续失败耗尽单 IP 突发配额（`Burst=4`）触发 `429`。 |
| API 返回 **HTTP `429`**（`code: "RATE_LIMITED"`） | 单条最多 `3` 次 | 读取 `error.retry_after_seconds`（缺失时读 `Retry-After` 头，保底 `1s`），叠加 `50ms–250ms` 随机抖动后等待重试。 |
| API 返回 **HTTP `502` / `504`** 且 `error.retryable == true` | 单条最多 `2` 次 | 指数退避（如 `2s`、`4s` + 抖动），耗尽仍失败则写入 `manifest.jsonl` 留待后续补跑。 |
| API 返回 `400` / `403` / `404` / `409` / `410` / `503` 或 `retryable == false` | **`0` 次** | 永久性业务结果（如 `INVALID_INPUT`、`UNSUPPORTED_PLATFORM`、`NO_MEDIA`、`CONTENT_UNAVAILABLE`、`UPSTREAM_BLOCKED`），立即记账跳过。 |
| CDN 下载单条候选返回 `403` / `5xx` / 超时 | 切换同作品下一候选 | 依次尝试剩余 `fallback_urls` 与备用 `sources[*]`；全部 `403`/`410` 时最多重调 1 次 `/api/parse`。 |

---

## 7. 不要做的事（反模式清单）

1. **不要对不可重试的业务错误码循环重试**：收到 `INVALID_INPUT`、`UNSUPPORTED_PLATFORM`、`NO_MEDIA`、`CONTENT_UNAVAILABLE`、`UPSTREAM_BLOCKED` 时，上游状态不会在几秒内改变，反复重打只会浪费并发槽位并触发上游风控。
2. **不要忽略 HTTP `401` 继续跑完整批清单**：错误、畸形、超长（`> 1024 B`）的 `Authorization` 头或服务端未开启 `DOKITOOL_OWNER_TOKEN` 均返回 HTTP `401`（JSON `code: "INVALID_INPUT"`），且每次失败都扣减匿名单 IP 限流桶（`Burst=4`，`0.2/s`）。必须在首个 `401` 时立即中止全批任务。
3. **不要对单条异常 URL 死磕重打**：无论是 API `5xx` 还是 CDN 下载中断，都必须设置严格的退避与单条最大尝试次数（1–3 次），失败后记入清单交由人工复核。
4. **不要预先解析大批量链接囤积数小时后再下载**：CDN 签名直链普遍具有分钟级至小时级 TTL（`expires_at`），囤积结果会导致后续下载大面积 `403`。
5. **不要将令牌放入 URL 查询参数，也不要向任何第三方媒体 CDN 发送 `Authorization` 头或 `Cookie`**：`DOKITOOL_OWNER_TOKEN` 仅通过 `Authorization: Bearer` 请求头直接发往你信任的 DokiTool API 源站（放在 `?token=...` 等查询参数里的令牌会被 `/api/parse` 等接口直接忽略，请求按匿名访客限流处理且不会报错提醒，同时还会暴露在日志和终端历史里）；请求平台 CDN 时使用无 Cookie 的干净 HTTP 客户端，杜绝凭据泄露。
6. **不要开启过高客户端并发**：纯 Go 快平台（抖音、X 快路径等）并发保持 `<= 8`，依赖 `yt-dlp` 的慢平台保持 `<= 1–2`（默认 `DOKITOOL_YTDLP_CONCURRENCY=2` 下建议 `1`），与服务端 `DOKITOOL_OWNER_CONCURRENCY` 及下游子进程池相匹配。

---

## 8. 参考脚本快速上手（`examples/agent_batch_download.py`）

仓库内置的 [examples/agent_batch_download.py](../examples/agent_batch_download.py) 零第三方 `pip` 依赖（仅使用 **Python 3.9+ 标准库** 并直接复用同仓纯标准库防 SSRF / IP pinning 传输模块 `tools/dokitool-agent/{security,http_transport}.py`），完整实现了认证急停（支持 `DOKITOOL_API_TOKEN` 优先与 `DOKITOOL_OWNER_TOKEN` 兼容）、`429` `Retry-After` 退避、分集 `/api/resolve`、多线路 `403` 切换与可选测速、公网 IP pinning 与逐跳重定向重验（阻断 `https -> http` 降级）、严格 `KNOWN_MEDIA_EXTENSIONS` 扩展名白名单、8 MiB JSON / 2 GiB 媒体体积上限、`.part` + `Range` 续传、`403`/`410` 单次重解析刷新及 `manifest.jsonl` 幂等断点记录。

> **运行目录说明**：该脚本直接复用同仓的 `tools/dokitool-agent/` 模块，**必须在仓库目录结构内运行**（例如在仓库根目录执行下方命令），不可将单个 `examples/agent_batch_download.py` 文件脱离仓库单独复制出去运行。

### 8.1 准备输入文件

创建 `urls.txt`（每行一条分享链接或分享文本，`#` 开头为注释）：

```text
# 抖音与 X 示例清单（请替换为真实公开作品链接）
https://www.douyin.com/video/EXAMPLE_ID_1
https://x.com/example_user/status/1234567890123456789
```

### 8.2 运行批量下载

```bash
export DOKITOOL_OWNER_TOKEN='<your-owner-token-from-secret-store>'

python3 -B examples/agent_batch_download.py \
  --api-base 'https://snap.example.com' \
  --input ./urls.txt \
  --output-dir ./downloads \
  --concurrency 4
```

若主要下载大体积抖音多线路视频，可附加 `--probe-routes` 启用首段 256 KiB 吞吐测速择优：

```bash
python3 -B examples/agent_batch_download.py \
  --api-base 'https://snap.example.com' \
  --input ./urls.txt \
  --output-dir ./downloads \
  --concurrency 3 \
  --probe-routes
```

### 8.3 断点续跑与结果核查

- 脚本每处理完一条输入都会向 `<output-dir>/manifest.jsonl`（可通过 `--manifest` 自定义路径）追加一行 JSON 记录，包含 `status`（`"ok"` / `"skipped"` / `"failed"`）、落盘文件名、字节数或错误码。
- 任务中断后以相同参数再次执行命令，脚本会自动跳过 `manifest.jsonl` 中 `status == "ok"` 的链接，并对未下完的 `.part` 文件尝试 `Range` 断点续传。
