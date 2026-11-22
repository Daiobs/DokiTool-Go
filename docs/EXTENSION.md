# DokiTool Chrome MV3 侧边栏原生扩展（`sidePanel` + `offscreen`）

DokiTool 提供面向桌面 Chrome 的原生 Manifest V3 侧边栏扩展，基于 **`sidePanel` 交互面板 + `background` Service Worker 调度 + `offscreen` 后台下载与无损合流引擎** 三层架构构建。关闭侧边栏不会中断正在进行的大文件下载、多图子目录落盘、YouTube 4K60 无损合流或 B 站 1080P（免登录）DASH 无损合流。

---

## 核心特性

1. **后台保活落盘（关掉侧边栏不断流）**
   - 媒体拉流、多线路顺序回退、HLS / 字节分片拼接、ZIP 打包与 Mediabunny 音视频无损合流均在独立的 `offscreen` 文档中写入浏览器私有文件系统（OPFS），完成后交由 `chrome.downloads` 落盘，并在收到终态事件（`complete` / `interrupted`）后权威回收 `Blob URL` 与 OPFS 临时文件。
2. **内置免油猴 YouTube 4K60 无损合流**
   - 零修改复用 `frontend/src/utils/youtubeHelperCore.js` 与 Mediabunny，配合仅作用于扩展自身请求（`initiatorDomains: [chrome.runtime.id]`）的动态 `declarativeNetRequest` 规则完成 `TVHTML5` 取址与 4K60 分离音视频浏览器内无损封装。
3. **内置 B 站 1080P（免登录）DASH 无损合流（AVC/HEVC/AV1 + 30280 AAC + 独立 M4A）**
   - **DNR Rule `1004` 防盗链来源头注入**：通过仅限定 `initiatorDomains: [chrome.runtime.id]` 的动态 `declarativeNetRequest` 规则 `1004`，仅对扩展自身发往 `bilivideo.com` / `bilivideo.cn` / `hdslb.com` / `akamaized.net` 的媒体请求注入 `Referer: https://www.bilibili.com/` 并剥离 `Origin` 与 `Cookie` 请求头，解决纯网页端无法携带 B 站防盗链 Referer 的限制，且绝不干扰浏览器正常标签页访问。
   - **Offscreen OPFS + `Mediabunny` 无损封装**：在独立 `offscreen` 文档中通过白名单 `fetch` 并发将视频 `.m4s`（支持 **1080P H.264 (AVC) / HEVC / AV1** 等全部可用清晰度）与 **30280 AAC** 音频 `.m4s` 流式写入浏览器私有文件系统（OPFS），随后由 `Mediabunny` 直接执行无重编码流拷贝合流输出完整 `.mp4`；合流结束、取消或终态落盘后确定性清理全部 OPFS 临时文件，无内存爆仓风险。
   - **独立 M4A、画质记忆与多 P 无缝衔接**：侧边栏顶部 `<video>` 预览继续使用 `durl` 渐进式 MP4 秒开播放；画质列表完整呈现各档位分辨率、编解码（同分辨率默认优先 `H.264` 兼顾全平台硬解与剪辑软件兼容，同时保留 `HEVC` / `AV1` 自由切换）与估算体积；选择「仅音频」时直接下载 `30280` 独立 `.m4a`；支持 B 站多 P 勾选批量合流与右键「极速下载」。
   - **零 Cookie、零服务端媒体中转**：服务端仅并行解析返回官方优先 CDN 地址（自动过滤未知第三方 PCDN，优先国内加速节点），全部 `.m4s` 媒体流量由用户本机扩展直连拉取；严格遵守零 Cookie 原则，免登录支持 **1080P（免登录，AVC/HEVC/AV1）+ 30280 AAC**，绝不读取或采集浏览器已登录的 B 站 Cookie。
4. **五种高频素材收集入口**
   - **点击工具栏扩展图标**：一键展开侧边栏。
   - **全局快捷键 `Alt+Shift+D`**：全屏看视频或刷信息流时直接呼出侧边栏并同步当前页（可在 `chrome://extensions/shortcuts` 自定义改键）。
   - **网页右键双菜单（零 Content Script 注入）**：
     - 「用 DokiTool 解析此链接」：展开侧边栏预览、选画质或勾选图集条目；
     - 「用 DokiTool 极速下载（最高画质 / 全部图集）」：无需打开侧边栏，后台直接按画质偏好静默落盘，工具栏角标实时显示进度与完成状态。
   - **跟随标签页自动同步**：仅在本地命中 14 个受支持平台作品链接时自动解析（支持防抖、同作品去重与手动结果防覆盖提示条）。
   - **批量链接队列模式**：粘贴整段多行分享文本，本地自动提取、过滤与去重受支持平台链接，按序解析并并发落盘到各自 `<安全标题>/` 子文件夹，单条失败不中断队列且支持一键重试。
5. **Pixiv 式勾选与子文件夹无上限保存**
   - 图集、实况照片（支持「视频 + 封面 / 仅视频 / 仅封面」三档过滤）与哔哩哔哩多 P 支持全选、反选与单项勾选。
   - 默认按 `<可选前缀>/<安全标题>/001.jpg` 逐个流式落盘（无内存体积上限），同时保留 `500 MiB` 以内的一键 ZIP 打包按钮；下载完成后可一键「打开文件夹」在系统文件管理器中定位文件。
6. **浅色 / 深色 / 跟随系统主题切换与动态工具栏状态**
   - 侧边栏支持 **浅色（Light）/ 深色（Dark）/ 跟随系统（System）** 三态主题切换，即时持久化保存且与系统深浅色联动。
   - 后台下载或极速下载进行时，扩展工具栏图标实时更新 **百分比进度角标（Badge）** 与 **动态悬停提示（Tooltip）**，无需展开侧边栏即可一眼掌握当前任务进度与完成状态。

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

- **后端地址**：默认连接线上 `https://snap.dokitool.com`；仅接受 `https://` 公开域名或本机调试回环地址 `http://127.0.0.1:<port>` / `http://localhost:<port>`（填写本机回环地址点击保存或测试时，浏览器会按需弹窗申请 `optional_host_permissions` 授权）。
- **专属 Bearer Token**：
  - 由用户本人粘贴保存于扩展隔离的 `chrome.storage.local`（绝不写入网页存储或会话存储）；
  - 点击 **「测试连通性」** 会请求 `GET /api/platforms?schema_version=1.0`：凭据有效显示 `200 已就绪`；凭据错误或已停用明确返回 `401 认证凭据无效`；留空保存则进入匿名模式（完全省略 `Authorization` 请求头）；
  - 若使用限定平台的受限密钥（如仅授权部分平台的 `friend` 密钥）解析未授权平台，侧边栏会原样展示服务端返回的 `当前凭据无权访问该平台`。
- **下载偏好**：可配置默认子目录前缀（如 `DokiTool`，内置跨平台非法字符、路径穿越 `..` 与 Windows 保留设备名清洗）、默认批量保存方式（子文件夹逐个保存 / 打包 ZIP）、默认画质偏好（最高画质 / 1080p 优先 / 仅音频）以及是否自动跟随标签页。

---

## 安全与隐私边界

- **零网页注入、零 `<all_urls>` 通配符**：`manifest.json` 不声明任何 `content_scripts`，不包含 `cookies`、`scripting`、`debugger`、`webRequestBlocking` 或未受限的 `declarativeNetRequest` 权限；`host_permissions` 仅列出 `https://snap.dokitool.com/*` 与 14 个平台显式媒体 CDN 域名。
- **浏览隐私防火墙**：标签页 URL 先在扩展本地执行 14 平台域名与路径语法匹配；访问任何非支持网站、`chrome://`、`file://` 或内网页面时均静默忽略，**向后端发送 0 请求**。
- **全链路无 Cookie 直连与零服务端媒体中转**：扩展发往后端 API 与各平台媒体 CDN（含 B 站 DASH `.m4s` 音视频流）的全部 `fetch` 请求均强制 `credentials: "omit"` 与 `referrerPolicy: "no-referrer"`，并由精确限定 `initiatorDomains: [chrome.runtime.id]` 的动态 DNR 规则（含针对 B 站防盗链的 Rule `1004`）剥离 `Cookie` 与扩展 `Origin` 头；全部媒体数据与 `Mediabunny` 无损合流均在用户本机浏览器内完成，服务端不中转媒体流量，亦不触碰浏览器已登录的站点账号状态或干扰正常网页浏览。
