# 发布检查与回执模板（`RELEASE-RECEIPT`）

本文档固定生产发布（及预演验证）的**服务端核对清单**、**自动化生产冒烟脚本调用方式**、**Mac 无头浏览器复测清单**与**最小回执模板**。后续发布 Issue 直接引用本文档对应章节编号即可，无需每次重写检查步骤。

> [!IMPORTANT]
> **公开仓库脱敏与张贴原则**
> 1. **严禁泄露敏感信息与本机隐私**：仓库与 Issue 公开可见，回执中**禁止出现**任何服务器 IP（IPv4/IPv6）、SSH 用户名/主机名/端口、安全组规则、`DOKITOOL_*` / `SNAP_*` 环境变量值或密钥文件哈希、`xsec_token`、微博中转 `ticket`、完整带签名的媒体 CDN URL（仅保留去重后的媒体域名，如 `v26-cold.douyinvod.com`），以及**执行机器的本机计算机名（hostname）、本地系统用户名与完整本地路径**（一律使用 `<WORK_DIR>` 等占位符）。
> 2. **原始输出按需张贴**：**原始命令输出只在某一步不通过（`FAIL`）时贴，并且只贴失败的那一步（脱敏后张贴）**。所有通过（`PASS`）步骤只填结论表与关键摘要（SHA-256、属主权限、计数、耗时、重试次数）。

---

## 1. 最小发布回执模板（复制到发布 Issue 评论）

````markdown
## 发布回执 — `<RELEASE_TAG>` (`<SHORT_SHA>`)

### 1.1 目标版本与窗口
- **目标 Commit SHA**: `<40-char-commit-sha>`
- **目标 Tree SHA**: `<40-char-tree-sha>`
- **构建产物标签 (`release_tag`)**: `build-<short-sha>`（`release-manifest.json` SHA-256: `<manifest-sha256>`）
- **执行时间窗口 (UTC)**: `YYYY-MM-DDTHH:MM:SSZ` ~ `YYYY-MM-DDTHH:MM:SSZ`
- **本次变更范围**: `日本主站 A: [是/否] | 上海节点 B: [是/否] | 前端静态产物: [是/否] | Mac 浏览器复测 D: [是/否]`

### 1.2 步骤结论表

#### A. 日本主站（`dokitool-go.service` + Caddy + 静态站点）
| 步骤 | 检查内容（参见 `docs/RELEASE-RECEIPT.md` §2.1） | 结论 | 关键核对摘要（无敏感信息） |
| --- | --- | --- | --- |
| A1 | 切换前现场保存（旧 PID、旧二进制/drop-in/`snap.caddy` SHA-256、环境变量名、前端软链） | `PASS` | 旧 `exe` SHA-256: `<prev-exe-sha256>`；`snap.caddy` SHA-256: `<caddy-sha256>` |
| A2 | 构建产物与 `version`/`catalog` 校验、追加上一版 `/assets/*` 哈希 chunk 与 Caddy `@api` 白名单核对 | `PASS` | 产物匹配 `release-manifest.json`；旧 `/assets/*` 已不覆盖并入；`@api` 白名单已核对 |
| A3 | 排空停机、端口释放确认、drop-in（字母前缀字典序且保留既有启动参数）/ 前端软链原子切换与启动 | `PASS` | 旧进程退出且监听端口释放后启动新实例 |
| A4 | 切换后 `/proc/$PID/exe`、保留旧 `/assets/*` (`200`) / 缺失 chunk (`404`)、journal 预检及 `/api/stats` (`401`) / `/api/statsx` (`404`) 核对 | `PASS` | 新 `exe` SHA-256: `<new-exe-sha256>`；预检 0 错误；旧 chunk `200`、缺失 chunk `404`；`/api/stats`->`401`、`/api/statsx`->`404` |
| A5 | 自动化生产冒烟 `scripts/prod-smoke/smoke.py`（见 §1.4） | `PASS` | `PASS=<n>, FAIL=0, SKIP=<k>` |

#### B. 上海解析节点（`dokitool-sh-pull.service`，未涉及时整表标 `SKIP`）
| 步骤 | 检查内容（参见 `docs/RELEASE-RECEIPT.md` §2.2） | 结论 | 关键核对摘要（无敏感信息） |
| --- | --- | --- | --- |
| B1 | 切换前现场保存（状态、启动参数、旧 `exe`/drop-in SHA-256、内存基线） | `PASS` / `SKIP` | 旧 `exe` SHA-256: `<prev-sh-sha256>`；`pull` 模式运行正常 |
| B2 | `shanghai-resolver` 产物 SHA-256 校验与落盘 | `PASS` / `SKIP` | 匹配 `release-manifest.json` |
| B3 | 切换重启、`/proc/$PID/exe` SHA-256 与 `pull` 通道就绪核对 | `PASS` / `SKIP` | 新 `exe` SHA-256: `<new-sh-sha256>`；长轮询已连接 |
| B4 | 停启回退与恢复抽查（按发布单要求执行或 `SKIP`） | `PASS` / `SKIP` | 停机回退无 `500`，恢复后返回 `*.douyinvod.com` |
| B5 | 切换 5 分钟后内存观察（`VmRSS` 与 `free -m`） | `PASS` / `SKIP` | `VmRSS=<n> MiB`，`free -m available=<n> MiB` |

#### D. Mac 阶段二无头静默浏览器复测（按 §3 风险分档执行：`skip` / `lite` / `full`）
- **风险分档**: `skip`（纯后端/配置/脚本且前端与 Caddy 0 diff） / `lite`（默认，约 10–15s） / `full`（含 B 站 + YouTube 零油猴实测，可选 `--with-mux-save`）
- **执行环境**: `macOS <ver> (<arch>) | Chrome <ver> (--headless=new --no-first-run --no-default-browser-check --use-mock-keychain --password-store=basic) | Official Extension v<ver> (id=ihamkldlkdibleacagiejklpfofapkpo, diff: 0, zero Tampermonkey)`
- **工具与收口**: `node scripts/prod-smoke/stage2_browser.mjs --profile <lite|full> ... | RESIDUAL_CHROME=0 | 脱敏扫描: 0 敏感项`

<!-- `skip` 时下表填一行 SKIP 并写明前端/Caddy 0 diff 依据；`lite` / `full` 直接粘贴 stage2_browser.mjs --md-out 输出 -->
| 检查项 (`id`) | 分组 (`group`) | 结论 (`status`) | 耗时 (ms) | 媒体域名 (`media_hostnames`) | 关键核对摘要 (`note`) |
| --- | --- | --- | ---: | --- | --- |
| `artifact_extension_zip` | `artifact_verify` | `PASS` / `SKIP` | 0 | - | 大小、SHA-256、文件数、`manifest.json` 边界校验 |
| `web_home_hydration` | `pure_web_chrome` | `PASS` / `SKIP` | 0 | - | `/` 首屏水合、主题启动、`0` CSP/控制台/页面报错 |
| `web_sw_bridge` | `pure_web_chrome` | `PASS` / `SKIP` | 0 | - | `{ scope: '/downloads/', type: 'module' }` SW 与 `/downloads/bridge.html` iframe `ping` |
| `web_monitor_responsive` | `pure_web_chrome` | `PASS` / `SKIP` | 0 | - | `/monitor` 桌面 + `390×844` 零横向溢出、`0` CSP/报错 |
| `ext_bridge_handshake` | `official_extension_chrome` | `PASS` / `SKIP` | 0 | - | 零修改官方扩展 `WEB_EXT_PING`、无「有新版」、无油猴全局、`0` CSP/报错 |
| `full_parse_bilibili` / `full_parse_youtube` | `full_live_parse` | `PASS` / `SKIP` | 0 | `*.bilivideo.com`, `*.googlevideo.com` | 仅 `full` 档运行（间隔 `>= 8.5s`）；可选 `full_mux_save` 核验双轨落盘 |

### 1.3 新增/变更配置 Drop-in（密钥已脱敏）与 SHA-256
- Drop-in SHA-256 清单：
  - `/etc/systemd/system/dokitool-go.service.d/<NEW_DROPIN>.conf`: `<sha256>`
- 新增非机密配置内容（如含机密值一律写 `<REDACTED>`；务必对照 A1 `systemctl show -p ExecStart` 原样保留线上全部既有运行参数，如 `-xhs-page-transport`、`-x-tombstone-fallback`、`-sh-resolver-mode` 等，切勿直接覆盖丢参）：
```ini
[Service]
ExecStart=
ExecStart=<RELEASES_ROOT>/<TARGET_SHA>/bin/dokitool serve -listen 127.0.0.1:<LISTEN_PORT> -client-identity caddy <KEEP_EXISTING_FLAGS>
```

### 1.4 生产冒烟脚本输出（`scripts/prod-smoke/smoke.py`）
<!-- 直接粘贴 smoke.py 生成的 Markdown 表与 JSON 块 -->

### 1.5 可直接执行的回滚命令
```bash
# 日本主站回滚至上一稳定版本 <PREV_SHA>（参见 docs/DEPLOYMENT.md 与 ops/release/）
# 1) 移除本次新增的高序号 ExecStart drop-in，daemon-reload 后确认生效定义恢复为 <PREV_SHA>
sudo rm -f /etc/systemd/system/dokitool-go.service.d/<NEW_DROPIN>.conf
sudo systemctl daemon-reload
systemctl show dokitool-go.service -p ExecStart,DropInPaths
# 2) 停机排空，确认本地监听端口释放后重新启动，并核对运行二进制 SHA-256 与 version
sudo systemctl stop dokitool-go.service
! ss -tln | awk -v port=":<LISTEN_PORT>$" '$4 ~ port {found=1} END {exit !found}'
sudo systemctl start dokitool-go.service
PID="$(systemctl show -p MainPID --value dokitool-go.service)"
sudo sha256sum "/proc/${PID}/exe"
"<RELEASES_ROOT>/<PREV_SHA>/bin/dokitool" version
# 3) 若涉及静态前端回退（如切换期间已有浏览器加载过失败版本首页，可先不覆盖保留其新增哈希 chunk）：
#    cp -n "<RELEASES_ROOT>/<FAILED_SHA>/frontend/dist/assets/"* "<RELEASES_ROOT>/<PREV_SHA>/frontend/dist/assets/"
ln -sfn "<RELEASES_ROOT>/<PREV_SHA>/frontend/dist" "<FRONTEND_SYMLINK>.tmp"
mv -T "<FRONTEND_SYMLINK>.tmp" "<FRONTEND_SYMLINK>"
```

### 1.6 失败步骤原始输出（全部 `PASS` 时填“无”）
无
````

---

## 2. 固定服务端核对命令清单

以下命令统一使用占位符（如 `<RELEASES_ROOT>`、`<TARGET_SHA>`、`<PREV_SHA>`、`<FRONTEND_SYMLINK>`、`<LISTEN_PORT>`、`$PID`），在各自目标主机本地终端执行，不在文档或回执中记录任何主机地址与密钥明文。

> [!WARNING]
> **systemd Drop-in 字典序与 Caddy `@api` 路径白名单规则**
> 1. **Drop-in 字典序**：systemd 按 ASCII 字典序依次加载 `/etc/systemd/system/<unit>.service.d/*.conf`，同名指令由**排在最后**的文件生效。`100-binary.conf` 的字典序排在 `99-binary.conf` **之前**（`'1' < '9'`），会被 `99-binary.conf` 覆盖而不生效！当目录内已存在 `99-*.conf` 时，新增覆盖片段必须使用字母前缀（如 `a01-binary.conf`、`a02-owner.conf`），并在 `daemon-reload` 后先用 `systemctl show -p ExecStart,DropInPaths` 确认最终生效值。
> 2. **Caddy `@api` 路径白名单**：线上 `/etc/caddy/snap.caddy` 对后端路由采用显式 `@api path ...` 白名单，未列入白名单的 `/api/*` 路径会被 Caddy 直接返回 `404`。**凡是新增 `/api/*` 接口路径的发布，必须同步备份并更新 `/etc/caddy/snap.caddy` 的 `@api` 列表**，校验通过后再重载 Caddy。

### 2.1 日本主站（`dokitool-go.service` + Caddy + 静态目录）

#### A1. 切换前现场保存
```bash
systemctl show dokitool-go.service -p ActiveState,SubState,MainPID,ExecStart,FragmentPath,DropInPaths
PID="$(systemctl show -p MainPID --value dokitool-go.service)"
sudo sha256sum "/proc/${PID}/exe"
sudo tr '\0' ' ' < "/proc/${PID}/cmdline"; echo
sudo sha256sum /etc/systemd/system/dokitool-go.service.d/*.conf /etc/caddy/snap.caddy
# 仅核对环境变量名称，严禁打印变量值；若存在密钥文件仅用 stat 核对属主权限（如 600 root:root），严禁 cat
sudo tr '\0' '\n' < "/proc/${PID}/environ" | awk -F= '/^(DOKITOOL_|SNAP_)/ {print $1}' | sort
readlink -f "<FRONTEND_SYMLINK>"
ss -tln | awk -v port=":<LISTEN_PORT>$" '$4 ~ port {print $1, $4}'
```

#### A2–A3. 产物校验、Caddy 白名单核对、追加哈希静态资源与原子切换
```bash
# 1) 对照 release-manifest.json 校验新版本不可变目录二进制与前端产物 SHA-256，并核对 version / catalog
sha256sum "<RELEASES_ROOT>/<TARGET_SHA>/bin/dokitool"
"<RELEASES_ROOT>/<TARGET_SHA>/bin/dokitool" version
"<RELEASES_ROOT>/<TARGET_SHA>/bin/dokitool" catalog >/dev/null

# 2) 若本次新增了 /api/* 路由：备份 /etc/caddy/snap.caddy，更新 @api path 白名单后校验并重载 Caddy
#    sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
#    sudo sha256sum /etc/caddy/snap.caddy

# 3) 若本次包含前端变更：确认 npm run build 产出的 index.html、downloads/*、helper/extension-version.json、helper/dokitool-chrome-extension.zip 摘要与清单一致；
#    将上一活动版本的 /assets/* 带哈希 chunk 不覆盖并入新版本目录（防止已打开旧页面的浏览器按需懒加载旧 chunk 时遇到 404），随后原子替换静态软链：
cp -n "<RELEASES_ROOT>/<PREV_SHA>/frontend/dist/assets/"* "<RELEASES_ROOT>/<TARGET_SHA>/frontend/dist/assets/"
ln -sfn "<RELEASES_ROOT>/<TARGET_SHA>/frontend/dist" "<FRONTEND_SYMLINK>.tmp"
mv -T "<FRONTEND_SYMLINK>.tmp" "<FRONTEND_SYMLINK>"

# 4) 写入新 drop-in（注意字母前缀字典序如 a01-binary.conf，并完整保留 A1 中的既有运行参数），daemon-reload 后先核对生效的 ExecStart
sudo systemctl daemon-reload
systemctl show dokitool-go.service -p ExecStart,DropInPaths

# 5) 停机排空并确认旧进程退出、本地监听端口完全释放后再启动新实例
sudo systemctl stop dokitool-go.service
! ss -tln | awk -v port=":<LISTEN_PORT>$" '$4 ~ port {found=1} END {exit !found}'
sudo systemctl start dokitool-go.service
```

#### A4. 切换后核对（含保留旧 chunk 与不读取令牌前提下的网关/鉴权边界校验）
```bash
systemctl show dokitool-go.service -p ActiveState,SubState,MainPID,ExecStart,DropInPaths
PID="$(systemctl show -p MainPID --value dokitool-go.service)"
sudo sha256sum "/proc/${PID}/exe"
"<RELEASES_ROOT>/<TARGET_SHA>/bin/dokitool" version
sudo tr '\0' ' ' < "/proc/${PID}/cmdline"; echo
# 仅核对环境变量名（例如用 grep -c '^DOKITOOL_OWNER_TOKEN$' 核对计数，绝不输出值）
sudo tr '\0' '\n' < "/proc/${PID}/environ" | awk -F= '/^(DOKITOOL_|SNAP_)/ {print $1}' | sort
# 若启用了 /etc/dokitool-go/owner.env，仅用 stat 确认属主权限为 600 root:root，严禁 cat
sudo test ! -e /etc/dokitool-go/owner.env || sudo stat -c '%a %U:%G' /etc/dokitool-go/owner.env
# 核对启动预检日志包含 yt-dlp shared engine verified 与 youtube helper runtime verified，且无 preflight failed / FATAL / panic
sudo journalctl -u dokitool-go.service -b --since "5 min ago" --no-pager | grep -Ei "verified|preflight|fatal|panic|error" || true
# 静态哈希 chunk 保留与缺失兜底核对（涉及前端变更时）：
#   - 至少一个保留的上一版 /assets/<PREV_CHUNK> 返回 200
#   - 不存在的 /assets/__nonexistent__.js 返回 404（不回退 SPA HTML）
curl -sS -o /dev/null -w "retained_prev_asset=%{http_code}\n" "https://snap.dokitool.com/assets/<PREV_CHUNK>"
curl -sS -o /dev/null -w "missing_asset=%{http_code}\n" "https://snap.dokitool.com/assets/__nonexistent__.js"
# 公网网关白名单与鉴权边界核对（零凭据只读请求）：
#   - /api/stats?schema_version=1.0 不带头应返回 401（证明 Caddy @api 已放行且 Go 鉴权生效）
#   - 未列入白名单的 /api/statsx 应返回 404（证明 Caddy /api/* 兜底拦截生效）
curl -sS -o /dev/null -w "stats_no_auth=%{http_code}\n" "https://snap.dokitool.com/api/stats?schema_version=1.0"
curl -sS -o /dev/null -w "unlisted_api=%{http_code}\n" "https://snap.dokitool.com/api/statsx"
```

#### A5. 运行生产冒烟脚本（在本地机器执行）
默认开启前端哈希（传 `--manifest` 时）、平台列表、缓存、X 快路径、抖音国内源、直连标记、15 平台回归与接口边界 `api_boundary`（在全部解析检查之后自动核对无头 `GET /api/stats?schema_version=1.0` -> `401` JSON 与随机未白名单 `GET /api/<random>` -> `404` JSON）：
```bash
python3 scripts/prod-smoke/smoke.py \
  --base-url https://snap.dokitool.com \
  --manifest "<WORK_DIR>/release-manifest.json" \
  --md-out "<WORK_DIR>/smoke-summary.md" \
  --json-out "<WORK_DIR>/smoke-report.json"
```

---

### 2.2 上海解析节点（`dokitool-sh-pull.service`）

#### B1. 切换前现场保存
```bash
systemctl show dokitool-sh-pull.service -p ActiveState,SubState,MainPID,ExecStart,DropInPaths
PID="$(systemctl show -p MainPID --value dokitool-sh-pull.service)"
sudo sha256sum "/proc/${PID}/exe"
# 核对 -pull-origin 等启动参数（鉴权 token 必须走 EnvironmentFile/drop-in，不得出现在 cmdline）
sudo tr '\0' ' ' < "/proc/${PID}/cmdline"; echo
# 仅计算 drop-in SHA-256，严禁 cat 打印含 token 的配置文件内容
sudo sha256sum /etc/systemd/system/dokitool-sh-pull.service.d/*.conf
awk '/VmRSS|VmHWM/ {print}' "/proc/${PID}/status"
free -m
```

#### B2–B5. 产物校验、切换生效、回退抽查与 5 分钟内存观察
```bash
# B2: 校验 shanghai-resolver 二进制 SHA-256 与 version
sha256sum "<RELEASES_ROOT>/<TARGET_SHA>/bin/shanghai-resolver"
"<RELEASES_ROOT>/<TARGET_SHA>/bin/shanghai-resolver" version

# B3: 更新高序号 drop-in（保留既有启动参数）后 daemon-reload、核对 ExecStart 并重启
sudo systemctl daemon-reload
systemctl show dokitool-sh-pull.service -p ExecStart,DropInPaths
sudo systemctl restart dokitool-sh-pull.service
PID="$(systemctl show -p MainPID --value dokitool-sh-pull.service)"
sudo sha256sum "/proc/${PID}/exe"
sudo tr '\0' ' ' < "/proc/${PID}/cmdline"; echo

# B4（按发布单要求选做）: 停启回退演练
#   1) sudo systemctl stop dokitool-sh-pull.service -> 验证主站抖音解析优雅降级（无 500）
#   2) sudo systemctl start dokitool-sh-pull.service -> 间隔 >= 10s 运行:
#      python3 scripts/prod-smoke/smoke.py --only douyin_domestic

# B5: 持续运行 5 分钟后复核内存占用
awk '/VmRSS|VmHWM/ {print}' "/proc/${PID}/status"
free -m
```

#### 上海侧标准回滚命令
```bash
sudo rm -f /etc/systemd/system/dokitool-sh-pull.service.d/<NEW_DROPIN>.conf
sudo systemctl daemon-reload
systemctl show dokitool-sh-pull.service -p ExecStart,DropInPaths
sudo systemctl restart dokitool-sh-pull.service
PID="$(systemctl show -p MainPID --value dokitool-sh-pull.service)"
sudo sha256sum "/proc/${PID}/exe"
"<RELEASES_ROOT>/<PREV_SHA>/bin/shanghai-resolver" version
```

---

## 3. Mac 阶段二无头静默浏览器复测规范（Section D：Chrome + 零修改官方扩展，免油猴）

阶段二统一使用仓内零第三方依赖工具 [`scripts/prod-smoke/stage2_browser.mjs`](../scripts/prod-smoke/stage2_browser.mjs)，针对 **Chrome + 零修改官方 MV3 扩展（`dokitool-chrome-extension.zip`，固定 ID `ihamkldlkdibleacagiejklpfofapkpo`，零油猴脚本）** 执行隔离无头实测，并在输出前执行 Fail-Closed 脱敏扫描与零残留进程校验。

### 3.1 阶段一与阶段二职责边界（消除重复核验）

| 阶段 | 标准工具 | 负责范围（唯一验收源） | 避免重复约定 |
| --- | --- | --- | --- |
| **阶段一（A4 / A5）** | `scripts/prod-smoke/smoke.py` + `scripts/check-download-headers.py` | 服务端进程/热重载、全量 `frontend_dist_files` 静态字节 SHA-256、16 核心平台目录与 API 冒烟（区分目录契约、部署开关与已知出口受限）、缓存/快路径/直连标记、`/api/stats` 匿名 `401` 与未白名单 `404`、下载桥接及 `/` 与 `/helper/extension-version.json` 固定 `mtime` 防 `304` 条件请求共 18 项安全头校验 | 不启动浏览器；负责全部纯 HTTP 静态哈希与后端接口回归 |
| **阶段二（Section D）** | `scripts/prod-smoke/stage2_browser.mjs` | **浏览器专属实测**：① 官方扩展 ZIP 安全边界验签（`manifest.json` 版本、`externally_connectable` 仅含线上主站、零 `content_scripts`/`cookies`/`<all_urls>`）；② 纯网页无头 Chrome 真实水合、主题防闪烁、`/downloads/` 模块 Service Worker 注册与 `/downloads/bridge.html` iframe `MessageChannel` `ping` 握手、`/monitor` 桌面 + `390×844` 移动端零横向溢出与 `0` CSP/控制台/页面报错；③ 零修改官方扩展无头 Chrome `WEB_EXT_PING`、无「有新版」误报与零油猴全局；④ `full` 档追加线上 B 站 + YouTube 零油猴真实解析与可选 Mediabunny 双轨落盘 | 阶段一已完整通过 `smoke.py` + `check-download-headers.py` 时，阶段二可追加 `--skip-http-checks` 跳过重复的纯 HTTP 响应头子项（仍强制下载并验签官方扩展 ZIP） |

### 3.2 强制运行与安全红线

1. **强制无头静默与零残留**：工具固定携带 `--headless=new --no-first-run --no-default-browser-check --use-mock-keychain --password-store=basic`，使用独立临时 `--user-data-dir`，POSIX 平台通过 `--remote-debugging-pipe` 私有 FD 管道（零本机 TCP 端口暴露）控制 CDP，仅在 Chrome 不支持 `--load-extension` 时按需附带 `--enable-unsafe-extension-debugging`；严禁弹出前台窗口或抢占焦点，`finally` 与信号处理分支强制销毁全部拉起的 Chrome 进程树、关闭所有非保活 HTTP 句柄与临时目录，并在退出前核验 `RESIDUAL_CHROME=0`。
2. **零本机硬编码与凭据禁令**：自动按 `DOKITOOL_CHROME_BIN` → Playwright 缓存最新 `Google Chrome for Testing` → 系统 Chrome/Chromium 探测浏览器，按 `--proxy` / `HTTPS_PROXY` / `HTTP_PROXY`（遵守 `NO_PROXY` 且回环直连）自动适配网络；拒绝 `--base-url` 或代理 URL 携带任何凭据；默认只读不修改 Git 跟踪文件、不执行 GitHub 写操作。
3. **可选本地扩展原子同步（Fail-Closed）**：`--sync-local-extension <dir>` 强制要求同时传入 `--manifest <release-manifest.json>`（严格校验 ZIP 的 SHA-256 与 `size_bytes`），仅在目标路径**未被 Git 跟踪**、版本号单调不降级且**全部无头 Chrome 检查通过之后**才以 `{ flag: "wx" }` 原子解压同步。
4. **运行态元数据与 Fail-Closed 输出脱敏**：常规模式同步校验 `/helper/extension-version.json`（`http_extension_version_json`）并与线上 ZIP 版本及 `sha256` 交叉一致；写入 `--json-out` / `--md-out` 或打印 stdout 前自动拦截任何完整 `http(s)://`/`ws(s)://` URL、IPv4/IPv6、`xsec_token`/`owner_token`/`Bearer`、`ticket=`/`sign=`/`sig=`、查询串、`/api/media/` 路径及 `/Users/`、`/home/`、`C:\Users\` 等本机路径，命中即非零退出。

### 3.3 三级风险分档（`skip` / `lite` / `full`）

| 风险分档 | 触发条件 | 执行动作与预期耗时 |
| --- | --- | --- |
| **`skip`** | 纯后端 Go / 运行时配置 / `yt-dlp` 升级 / 运维脚本发布，且 `frontend-dist.tar.gz`、`dokitool-chrome-extension.zip` 与 `snap.caddy` 与当前线上版本 **`0 diff`（字节级一致）** | **免跑浏览器**；在发布单评论核对阶段一回执、记录前端与 Caddy `0 diff` 证据即可收口关单 |
| **`lite`**（默认） | 日常前端页面/样式、`/monitor`、Caddy 安全头/CSP/预压缩或下载 SW 改动（未改动下载合流内核、扩展通信协议或核心解析交互） | 并行执行：① 扩展 ZIP 与安全头/预压缩/真 `404` 核验（已过阶段一时可加 `--skip-http-checks`）；② 纯网页无头 Chrome（`/` 水合 + SW iframe `ping` + `/monitor` 桌面/`390×844` 零溢出）；③ 零修改官方扩展无头 Chrome（`WEB_EXT_PING` + 无「有新版」 + 零油猴 + `0` 报错）。总耗时约 **10–15s** |
| **`full`** | 改动下载调度、Mediabunny 合流、Chrome 扩展源码/协议、YouTube 免油猴链路或前端解析结果交互 | 在 `lite` 全部检查基础上追加真实解析抽测（国内 B 站 + 强制间隔 `>= 8.5s` 后的海外 YouTube 零油猴链路），校验扩展连接徽标、主下载按钮与 `0` CSP/报错；改动合流或文件名逻辑时追加 `--with-mux-save` 实测 Mediabunny 双轨落盘与非 36 位 UUID 文件名 |

### 3.4 标准执行命令

```bash
# 1. 日常 lite 档（推荐默认，配合本次发版 release-manifest.json，约 10–15s）
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile lite \
  --manifest "<WORK_DIR>/release-manifest.json" \
  --md-out "<WORK_DIR>/stage2-receipt.md" \
  --json-out "<WORK_DIR>/stage2-report.json"

# 2. 阶段一已完整通过 smoke.py + check-download-headers.py 时，跳过重复 HTTP 项
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile lite \
  --skip-http-checks \
  --manifest "<WORK_DIR>/release-manifest.json" \
  --md-out "<WORK_DIR>/stage2-receipt.md"

# 3. 高风险 full 档（下载/合流/扩展/解析交互改动必跑；涉及合流落盘时追加 --with-mux-save）
node scripts/prod-smoke/stage2_browser.mjs \
  --base-url https://snap.dokitool.com \
  --profile full \
  --with-mux-save \
  --manifest "<WORK_DIR>/release-manifest.json" \
  --sync-local-extension frontend/dist-extension \
  --md-out "<WORK_DIR>/stage2-receipt.md" \
  --json-out "<WORK_DIR>/stage2-report.json"
```

### 3.5 最小阶段二回执模板（由 `--md-out` 自动生成，可直接 `gh issue comment`）

````markdown
## 发布回执（阶段二：无头静默浏览器复测） — `<RELEASE_TAG>` (`<SHORT_SHA>`)

- **目标站点**: `snap.dokitool.com` | **风险档位**: `<lite|full>` (`--skip-http-checks=<false|true>`) | **生成时间 (UTC)**: `YYYY-MM-DDTHH:MM:SSZ` | **总耗时**: `<X.XX>s`
- **执行环境**: `darwin/arm64 | HeadlessChrome/<ver> (--headless=new --no-first-run --no-default-browser-check --use-mock-keychain --password-store=basic) | Official Extension v<ver> (id=ihamkldlkdibleacagiejklpfofapkpo, diff: 0, zero Tampermonkey)`
- **网络与资源清理**: `proxy=<direct|env-proxy|cli-proxy> (no-credentials) | RESIDUAL_CHROME=0 | 脱敏扫描: 0 敏感项`
- **汇总**: `PASS=<n>, FAIL=0, SKIP=<k>`

| 检查项 (`id`) | 分组 (`group`) | 结论 (`status`) | 耗时 (ms) | 媒体域名 (`media_hostnames`) | 关键核对摘要 (`note`) |
| --- | --- | --- | ---: | --- | --- |
| `artifact_extension_zip` | `artifact_verify` | **PASS** | 320 | - | `size=<N>B, sha256[:12]=<hex>, files=13, v4.5.2, id=ihamkldlkdibleacagiejklpfofapkpo, manifestMatch=true, zeroContentScripts=true, zeroCookies=true` |
| `http_extension_version_json` | `http_security` | **PASS** | 90 | - | `version=4.5.2, id=ihamkldlkdibleacagiejklpfofapkpo, sha256Match=true, cacheControl=no-store` |
| `web_home_hydration` | `pure_web_chrome` | **PASS** | 450 | - | `hydrated=true, themeBootstrap=true, colorScheme=light, csp=0, consoleErr=0, pageErr=0` |
| `web_sw_bridge` | `pure_web_chrome` | **PASS** | 120 | - | `scope=/downloads/, bridgeControlled=true, workerBuild=<BUILD>, admission=true` |
| `web_monitor_responsive` | `pure_web_chrome` | **PASS** | 280 | - | `desktop(1440x900) overflow=0px, mobile(390x844) overflow=0px, csp=0, consoleErr=0, pageErr=0` |
| `ext_bridge_handshake` | `official_extension_chrome` | **PASS** | 680 | - | `WEB_EXT_PING ok (v4.5.2, id=ihamkldlkdibleacagiejklpfofapkpo, caps=dash_mux,direct_download,youtube_parse,youtube_mux), noUpdateNotice=true, ytHelperGlobal=false, csp=0, consoleErr=0, pageErr=0` |
````
