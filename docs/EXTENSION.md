# DokiTool Chrome MV3 侧边栏原生扩展（`v4.5.0` · `sidePanel` + `offscreen`）

DokiTool 提供面向桌面 Chrome 的原生 Manifest V3 侧边栏扩展（当前版本 **`v4.5.0`**，固定扩展 ID `ihamkldlkdibleacagiejklpfofapkpo`），基于 **`sidePanel` 交互面板 + `background` Service Worker 调度 + `offscreen` 后台下载与无损合流引擎** 三层架构构建。关闭侧边栏不会中断正在进行的大文件下载、多图子目录落盘、YouTube 4K60 无损合流或 B 站 1080P（免登录）DASH 无损合流。

> **v4.5.0 运行态同步与安全加固**：Web 主站与扩展侧边栏统一以运行态 `/helper/extension-version.json`（附带 ZIP `sha256` 元数据）作为更新真相源，长驻未刷新页面打开弹窗或切回前台时实时同步最新版本号；自定义本机回环后端收紧为单端口精确可选权限并在切换源站时自动回收旧端口授权；外部网页桥接拒绝非白名单 `sender.url`，被动落盘执行严格安全后缀白名单，字幕下载在重定向后强制重验白名单域名，且 `task.error` 自动剥离 URL/凭据片段。

---

## 核心特性

1. **后台保活落盘与脱敏历史记录持久化（v4.4.0，关掉侧边栏不断流，SW 休眠重启不丢记录）**
   - 媒体拉流、多线路顺序回退、HLS / 字节分片拼接、ZIP 打包与 Mediabunny 音视频无损合流均在独立的 `offscreen` 文档中写入浏览器私有文件系统（OPFS），完成后交由 `chrome.downloads` 落盘，并在收到终态事件（`complete` / `interrupted`）后权威回收 `Blob URL` 与 OPFS 临时文件。
   - **Guardrail G6 脱敏任务历史持久化（`dokitool_ext_task_history_v1`）**：在 `chrome.storage.local` 持久化最近 50 条任务元数据（标题、平台、文件名、终态、大小、`chromeDownloadId` 及规范化来源页 `sourcePageUrl` / `itemId` / `variantId`），**严格排除任何带签名 CDN URL、合流 Spec、敏感查询参数、Cookie 与 Bearer Token**。Service Worker 休眠重启后自动恢复历史列表并标注 **「历史」** 徽章：休眠前未完成任务统一收敛为失败态（`后台休眠中断，点击重试将重新解析`），点击 **「重试」** 会按来源页重新解析最新直链，已完成历史记录继续支持一键 **「打开文件夹」** 与 **「清空已完成」**。
2. **内置免油猴 YouTube 4K60 无损合流与纯客户端 VTT/SRT/双语字幕下载（v4.4.0）**
   - 零修改复用 `frontend/src/utils/youtubeHelperCore.js` 与 Mediabunny，配合仅作用于扩展自身请求（`initiatorDomains: [chrome.runtime.id]`）的动态 `declarativeNetRequest` 规则完成 `TVHTML5` 取址与 4K60 分离音视频浏览器内无损封装。
   - **纯客户端字幕下载与双语合并导出**：侧边栏直接列出媒体返回的全部 `attachments[role="subtitle"]` 字幕轨，清晰标注语言与 **「人工」 / 「自动」**（`track_kind`）标签，支持单轨 `.vtt` / `.srt` 转换以及双语主副字幕时间轴合并导出（纯本地 Blob 落盘，不持久化签名链接）。白名单字幕（含 `www.youtube.com/api/timedtext`，由 DNR Rule `1002` 剥离 Cookie/Origin）强制 `credentials: "omit"`、`referrerPolicy: "no-referrer"` 与流式 `<= 5 MiB` 安全上限；非白名单长尾字幕域名绝不绕过白名单，诚实标注 **「非白名单」** 并提供 **「复制直链」** 与 **「打开」** 移交浏览器处理。
3. **内置 B 站 1080P（免登录）DASH 无损合流（AVC/HEVC/AV1 + 30280 AAC + 独立 M4A）**
   - **DNR Rule `1004` 与窄匹配规则 `1006–1008` 防盗链来源头注入**：通过仅限定 `initiatorDomains: [chrome.runtime.id]` 的动态 `declarativeNetRequest` 规则，对扩展自身发往 `bilivideo.com` / `bilivideo.cn` / `hdslb.com`（Rule `1004`）以及 B 站海外 Akamai UPOS 节点（高优先级 `priority: 3` 的窄匹配 Rule `1006`：`upos-*.akamaized.net`、Rule `1007`：`*bili*.akamaized.net`、Rule `1008`：`akamaized.net` + `/upgcxcode/`）的媒体请求注入 `Referer: https://www.bilibili.com/` 并剥离 `Origin` 与 `Cookie` 请求头；其余非 B 站 `*.akamaized.net` 流量（如 Vimeo、Facebook、Tumblr）落入 Rule `1005` 仅剥离 `Origin` 与 `Cookie`（零 B 站 Referer 污染），且绝不干扰浏览器正常标签页访问。
   - **Offscreen OPFS + `Mediabunny` 无损封装**：在独立 `offscreen` 文档中通过白名单 `fetch` 并发将视频 `.m4s`（支持 **1080P H.264 (AVC) / HEVC / AV1** 等全部可用清晰度）与 **30280 AAC** 音频 `.m4s` 流式写入浏览器私有文件系统（OPFS），随后由 `Mediabunny` 直接执行无重编码流拷贝合流输出完整 `.mp4`；合流结束、取消或终态落盘后确定性清理全部 OPFS 临时文件，无内存爆仓风险。
   - **独立 M4A、画质记忆与多 P 无缝衔接**：侧边栏顶部 `<video>` 预览继续使用 `durl` 渐进式 MP4 秒开播放；画质列表完整呈现各档位分辨率、编解码（同分辨率默认优先 `H.264` 兼顾全平台硬解与剪辑软件兼容，同时保留 `HEVC` / `AV1` 自由切换）与估算体积；选择「仅音频」时直接下载 `30280` 独立 `.m4a`；支持 B 站多 P 勾选批量合流与右键「极速下载」。
   - **零 Cookie、零服务端媒体中转**：服务端仅并行解析返回官方优先 CDN 地址（自动过滤未知第三方 PCDN，优先国内加速节点），全部 `.m4s` 媒体流量由用户本机扩展直连拉取；严格遵守零 Cookie 原则，免登录支持 **1080P（免登录，AVC/HEVC/AV1）+ 30280 AAC**，绝不读取或采集浏览器已登录的 B 站 Cookie。
4. **五种高频素材收集入口**
   - **点击工具栏扩展图标**：一键展开侧边栏。
   - **全局快捷键 `Alt+Shift+D`**：全屏看视频或刷信息流时直接呼出侧边栏并同步当前页（可在 `chrome://extensions/shortcuts` 自定义改键）。
   - **网页右键三菜单（零 Content Script 注入、零新增权限）**：
     - 「用 DokiTool 解析此链接」：展开侧边栏预览、选画质或勾选图集条目（支持 14 个核心平台及后端启用 `DOKITOOL_YTDLP_GENERIC_ENABLED` 时的长尾公网媒体链接）；
     - 「用 DokiTool 极速下载（最高画质 / 全部图集）」：无需打开侧边栏，后台直接按画质偏好静默落盘，工具栏角标实时显示进度与完成状态；
     - 「用 DokiTool 解析选中链接」（v4.4.0，`contexts: ["selection"]`）：在网页选中包含分享口令或纯文本链接的文字后右键一键提取首个合法公网链接并在首行同步打开侧边栏解析，无需额外权限或页面脚本注入。
   - **跟随标签页自动同步（严格核心 14 平台隐私防火墙）**：仅在本地命中 14 个核心受支持平台作品链接时自动解析（支持防抖、同作品去重与手动结果防覆盖提示条）；浏览任何长尾或外部网站时绝不自动外发后端请求。
   - **主动输入与批量链接队列模式（支持长尾平台与三档安全交付）**：用户主动在侧边栏输入框或批量队列粘贴分享文本时，自动提取并去重核心 14 平台及合法公网长尾分享链接（拒绝 `chrome://`、`file://`、IP、内网主机名、本站域名及裸根域名），按序解析并落盘。下载执行按目标媒体域名自动分级：
     - **白名单 CDN（OPFS / 无损合流）**：继续走 `offscreen` OPFS 拉流、多线路回退与 `Mediabunny` 无损封装；
     - **非白名单单文件直链（移交浏览器原生下载器）**：无需申请 `<all_urls>` 扩展通配权限，直接移交 Chrome 原生 `chrome.downloads.download` 下载器保存并追踪进度与打开文件夹——在此模式下扩展**不代理请求、不读取响应体、不附加 Cookie**，等价于浏览器原生点击下载；
     - **非白名单 HLS / 分离流（需外链）**：清晰标注 **「需外链 · 非白名单流」**，自动优先选中可直下的渐进式单文件版本，同时提供 **「复制直链」** 与 **「打开原帖」** 操作。
5. **Pixiv 式勾选、多 P 后台流式队列（v4.4.0）与子文件夹无上限保存**
   - 图集、实况照片（支持「视频 + 封面 / 仅视频 / 仅封面」三档过滤）与哔哩哔哩多 P 支持全选、反选与单项勾选。
   - **多 P 后台流式队列（`ENQUEUE_MULTIPART_ITEMS`）**：勾选包含多 P 或按需延迟解析分集（`deferred`）点击保存子文件夹时，立即返回排队任务至底部任务抽屉并交由后台 Service Worker 以受控并发（解析并发 `<= 2`、下载并发受限于队列上限）边解析边下载，绝不阻塞侧边栏交互，支持单任务即时取消与 Tier-2 `refresh_url` 回退。
   - 默认按 `<可选前缀>/<安全标题>/001.jpg` 逐个流式落盘（无内存体积上限），同时保留 `500 MiB` 以内的一键 ZIP 打包按钮；下载完成后可一键「打开文件夹」在系统文件管理器中定位文件。
6. **浅色 / 深色 / 跟随系统主题切换与动态工具栏状态**
   - 侧边栏支持 **浅色（Light）/ 深色（Dark）/ 跟随系统（System）** 三态主题切换，即时持久化保存且与系统深浅色联动。
   - 后台下载或极速下载进行时，扩展工具栏图标实时更新 **百分比进度角标（Badge）** 与 **动态悬停提示（Tooltip）**，无需展开侧边栏即可一眼掌握当前任务进度与完成状态。
7. **管理员只读状态胶囊与 Web 端宽屏解析监控大盘入口（`/monitor`）**
   - **侧边栏只读状态胶囊（严格 `owner` 权限隔离）**：仅当用户在设置中配置了 `owner` 角色 Bearer Token 且后台 `GET /api/stats?schema_version=1.0` 返回 `200 OK` 时，侧边栏才会展示紧凑的管理员状态胶囊，一眼呈现今日解析次数、今日成功率、上海节点在线状态灯以及 **「解析监控大盘 ↗」** 入口按钮；匿名访客（未配置 Token，不向 `/api/stats` 发起请求）或普通 `friend` / `agent` 角色密钥（服务端返回 `401`）下该状态胶囊静默隐藏，绝不弹出任何报错提示。
   - **一键跳转 Web 原生宽屏解析监控大盘（`${apiOrigin}/monitor`）**：扩展不再冗余打包重复的 `monitor.html` 页面；点击状态胶囊中的 **「解析监控大盘 ↗」** 按钮后，扩展会以纯净的 `${apiOrigin}/monitor` 地址（**严格零查询参数、零 `#hash`、零令牌透传**）在新标签页打开（或复用已打开的）站点 Web 原生监控大盘。用户在该页面独立输入 Owner Token（仅存内存或单标签页 `sessionStorage`，不写入持久存储），即可查看纯原生 SVG + CSS 渲染（零第三方图表库、严格零内联 CSP）的五大只读观测模块：
     - **核心指标卡**：今日解析总量与成功率（含较昨日变化）、缓存命中率与内存占用、上海节点在线 Worker 数与命中率、后端版本与在线时长；
     - **运行时开关矩阵与并发池水位**：只读展示后端 `runtime` 全部 11 项脱敏开关，以及 `fast` / `slow` / `generic_slow` / `owner` 准入池与 `ytdlp` / `ytdlp_generic` 槽位实时活跃与排队水位条；
     - **原生 SVG 趋势图**：支持「近 7 天 / 近 30 天」切换的日度成功/失败堆叠柱状图 + 成功率折线图，以及「近 24 小时」请求波动堆叠柱状图（按 `Asia/Shanghai` UTC+8 统计，支持悬停明细）；
     - **平台每日解析健康度总览表**：支持「今日 / 昨日 / 近 7 天 / 近 30 天 / 启动以来」五档窗口切换与排序，展示各平台（含核心平台与长尾平台）解析量、成功率进度条、高亮错误码标签与 P95 延迟；
     - **多 Key 调用统计表**：脱敏展示各已配置 API Key 的 `id`、角色、启用状态、请求/成功/错误/缓存命中/限流/越权次数与当前并发占用（绝不显示令牌或摘要）。

---

## 安装与在 Chrome 中加载

环境要求：桌面版 **Google Chrome `116+`** 或 **Microsoft Edge `116+`**（支持 MV3 `sidePanel`、`offscreen` 与 `runtime.getContexts`）。

### 方式一：直接下载预构建压缩包（推荐普通用户）

匿名开箱即用，无需登录或配置 Token（如需接入专属配额，可在安装后通过扩展设置页按需绑定 Bearer Key）：

1. **下载并解压扩展包**：
   - 从线上站点直接下载：[`https://snap.dokitool.com/helper/dokitool-chrome-extension.zip`](https://snap.dokitool.com/helper/dokitool-chrome-extension.zip)（也可在 DokiTool 首页顶部导航或页脚点击 **「Chrome 扩展」** 弹窗一键下载），或前往本仓库 GitHub Releases 下载同名附件 `dokitool-chrome-extension.zip`；
   - 解压压缩包（macOS 双击 / Windows 右键「全部解压缩」）。压缩包根目录直接包含 `manifest.json`（无多余嵌套外层目录），解压得到的文件夹即可直接加载。
2. **打开扩展页并开启开发者模式**：
   - 在 Chrome 地址栏打开 `chrome://extensions/`；
   - 打开右上角的 **「开发者模式」（Developer mode）** 开关。
3. **直接拖入文件夹完成加载**：
   - 将第 1 步解压出的文件夹**直接拖进 `chrome://extensions/` 页面**（或点击左上角 **「加载已解压的扩展程序」（Load unpacked）** 选中该文件夹）；
   - 建议点击浏览器右上角拼图图标，将 **「DokiTool 素材下载助手」** 固定（Pin）到工具栏，随时一键呼出侧边栏。

> **后续更新**：下载新版 `dokitool-chrome-extension.zip` 解压覆盖原文件夹，然后在 `chrome://extensions/` 点击扩展卡片上的刷新按钮即可，已保存的偏好、主题与设置不会丢失。

### 方式二：开发者本地源码构建

环境要求额外需要 **Node.js `20+`**：

```bash
cd frontend
npm ci

# 1. 构建未打包的本地调试目录 -> frontend/dist-extension/
npm run build:extension

# 2. 构建确定性可分发压缩包 -> frontend/dist/helper/dokitool-chrome-extension.zip
npm run build:extension:zip
```

说明：
- `npm run build:extension` 输出独立未打包产物至 `frontend/dist-extension/`（该目录受 `.gitignore` 与 `scripts/check-public-files.py` 双重门禁保护，绝不纳入 Git 提交），并在构建后自动执行 MV3 权限最小化、禁通配符与零远程脚本静态门禁校验；
- `npm run build:extension:zip`（以及完整生产构建 `npm run build`）会使用零外部依赖的确定性 PKZIP 2.0 写入器（固定时间戳 `2026-01-01 00:00:00`、UTF-8 编码标志与 POSIX 词典序）生成根目录直出 `manifest.json` 的 `frontend/dist/helper/dokitool-chrome-extension.zip`，并执行全量字节级校验；
- 出于安全边界，`--dev-loopback` 测试构建模式严格拒绝配合 `--zip-out` 打包为可分发压缩包。
- 本地构建完成后，按上文步骤在 `chrome://extensions/` 加载 `frontend/dist-extension` 目录即可。

---

## 配置专属 Bearer Token 与下载偏好

点击侧边栏右上角的齿轮按钮打开 **设置抽屉**：

- **后端地址**：默认连接线上 `https://snap.dokitool.com`；仅接受 `https://` 公开域名或本机调试回环地址 `http://127.0.0.1:<port>` / `http://localhost:<port>`（填写本机回环地址点击保存或测试时，浏览器仅按当前**单一精确端口**弹窗申请 `optional_host_permissions` 授权，且切换回线上或更换端口时自动回收先前授予的回环权限）。
- **专属 Bearer Token**：
  - 由用户本人粘贴保存于扩展隔离的 `chrome.storage.local`（绝不写入网页存储或会话存储）；
  - 点击 **「测试连通性」** 会请求 `GET /api/platforms?schema_version=1.0`：凭据有效显示 `200 已就绪`；凭据错误或已停用明确返回 `401 认证凭据无效`；留空保存则进入匿名模式（完全省略 `Authorization` 请求头）；
  - 当保存的凭据属于 `owner` 角色时，侧边栏会自动解锁只读管理员状态胶囊及 Web 端宽屏 **解析监控大盘（`${apiOrigin}/monitor`）** 新标签页入口（扩展不再内置重复的 `monitor.html`，打开的 URL 严格不含查询参数、`#hash` 或令牌）；使用 `friend` / `agent` 角色凭据或匿名模式时，该入口静默隐藏且不影响常规解析与下载；
  - 若使用限定平台的受限密钥（如仅授权部分平台的 `friend` 密钥）解析未授权平台，侧边栏会原样展示服务端返回的 `当前凭据无权访问该平台`。
- **下载偏好**：可配置默认子目录前缀（如 `DokiTool`，内置跨平台非法字符、路径穿越 `..` 与 Windows 保留设备名清洗）、默认批量保存方式（子文件夹逐个保存 / 打包 ZIP）、默认画质偏好（最高画质 / 1080p 优先 / 仅音频）以及是否自动跟随标签页。

---

## 安全与隐私边界

- **零网页注入、零 `<all_urls>` 通配符**：`manifest.json` 不声明任何 `content_scripts`，不包含 `cookies`、`scripting`、`debugger`、`webRequestBlocking` 或未受限的 `declarativeNetRequest` 权限；`host_permissions` 仅列出 `https://snap.dokitool.com/*` 与 14 个平台显式媒体 CDN 域名。
- **浏览隐私防火墙**：标签页自动同步（`autoFollowTab` / `onUpdated` / `onActivated`）严格限定在本地 14 个核心平台域名与路径语法匹配；浏览长尾站点、`chrome://`、`file://` 或内网页面时均静默忽略，**向后端发送 0 请求**。仅在用户主动手动输入、批量队列粘贴或点击右键菜单时才允许将合法公网长尾链接提交至 `GET /api/parse?platform=all`。
- **全链路无 Cookie 直连、非白名单原生移交、零服务端媒体中转与监控页隔离**：扩展发往后端 API（含只读 `/api/stats` 监控查询）与各平台白名单媒体 CDN（含 B 站 DASH `.m4s` 音视频流）的全部 `fetch` 请求均强制 `credentials: "omit"` 与 `referrerPolicy: "no-referrer"`，并由精确限定 `initiatorDomains: [chrome.runtime.id]` 的动态 DNR 规则（含针对 B 站国内 CDN 的 Rule `1004` 与严格收窄至 B 站海外 Akamai UPOS 节点的 `priority: 3` 规则 `1006–1008`，同时保证非 B 站 `akamaized.net` 落入 Rule `1005` 零 Referer 注入）剥离 `Cookie` 与扩展 `Origin` 头；对不在白名单内的长尾渐进式单文件直链，扩展不申请 `<all_urls>` 权限，而是直接移交 Chrome 浏览器原生下载器（`chrome.downloads.download`），扩展本身不代理请求、不读取响应体、不附加 Cookie；扩展不再打包重复的 `monitor.html`，侧边栏「解析监控大盘 ↗」仅以纯净 URL（`${apiOrigin}/monitor`，零查询串、零 `#hash`、零令牌透传）在新标签页打开 Web 原生监控大盘，`Mediabunny` 严格隔离于 `offscreen` 打包产物内而不进入 `background` 或 `sidepanel`；全部媒体数据与 `Mediabunny` 无损合流均在用户本机浏览器内完成，服务端不中转媒体流量，亦不触碰浏览器已登录的站点账号状态或干扰正常网页浏览。
