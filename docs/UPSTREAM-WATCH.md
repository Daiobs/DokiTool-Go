# 上游运行时版本每日检查

GitHub Actions 的 **Watch upstream updates**（[`.github/workflows/upstream-watch.yml`](../.github/workflows/upstream-watch.yml)）在 GitHub 托管的 runner 上运行，无需维护者的本地电脑保持开机。计划为每天北京时间 **09:00**（UTC `01:00`），也可以在仓库 Actions 页面通过 `workflow_dispatch` 手动触发。

## 监控对象与本地基线对比

`DokiTool-Go` 在生产环境与门禁流水线中锁定了经 SHA-256 严格校验的外部运行时版本。脚本 [`scripts/check-upstream-updates.py`](../scripts/check-upstream-updates.py) 从仓库 Go 源码读取当前锁定版本，校验全仓 5 处锁定文件的一致性，并与两个上游仓库的**公开正式版 Release**（`draft: false` 且 `prerelease: false`）进行版本序对比：

| 上游仓库 | 本地权威锁定与跨文件一致性校验范围 | 版本序比对规则 |
| --- | --- | --- |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | `backend/internal/ytengine/engine.go`（`const PinnedVersion` 与 `OfficialSHA256Sums*` 中的 `yt-dlp_linux` SHA-256）、`.github/workflows/gateway-isolation.yml`（下载 URL 版本与 `yt-dlp_linux` SHA-256） | 按 3/4 段零填充 CalVer `YYYY.MM.DD[.N]` 解析为 4 元整数元组 `(year, month, day, patch_or_0)` 与本地锁定版本比较 |
| [denoland/deno](https://github.com/denoland/deno) | `backend/internal/platform/youtube/ejs_sandbox.go`（`PinnedDenoVersion` 与 `OfficialDenoSHA256Sums*` 中的 `deno-x86_64-unknown-linux-gnu` SHA-256）、`.github/workflows/release-build.yml`（`v{version}` 下载 URL、`deno {version}` 版本断言与 Linux x86_64 SHA-256）、`scripts/requirements-validation.txt`（`deno=={version}`） | 剥离上游正式版标签前导 `v`（如 `v2.9.8` → `2.9.8`）后按 3 段 SemVer 解析为 `(major, minor, patch)` 与本地锁定版本比较 |

汇总表与变更通知按版本序区分四种状态：
- `upstream == locked`：`已对齐`
- `upstream > locked`：`发现新正式版`
- `upstream < locked`：`上游 latest 低于本地锁定`（覆盖上游回滚最新正式版、旧分支补丁未设 `make_latest=false` 或本地先行升级）
- 上游标签无法按预期格式解析：`版本不一致（需人工核对）`（经 `safe_text` 转义后安全降级展示，不抛异常中断通知）
- 若上述 5 处本地锁定文件之间出现版本号或 Linux x86_64 SHA-256 漂移，采用**“PR 硬门禁阻断 + 每日巡检不中断告警”**职责切分：
  - **PR 门禁前置阻断**：`python3 -B scripts/check-upstream-updates.py --check-local-pins`（零网络请求、无需 `GITHUB_TOKEN`）调用 `verify_local_pin_consistency` 强校验全部 5 处锁定文件的一致性，已同时接入 PR 工作流 [`.github/workflows/go-migration.yml`](../.github/workflows/go-migration.yml)（其 `pull_request.paths` 亦覆盖 `release-build.yml`、`gateway-isolation.yml` 与 `upstream-watch.yml`）及本地离线总门禁 [`scripts/go-migration/check.py`](../scripts/go-migration/check.py)，在合并前直接拦截任何未同步更新的改动（退出码 `1`）。
  - **每日巡检持续汇报**：`scripts/tests` 离线单测仅使用临时目录合成夹具验证逻辑与 `--check-local-pins` 行为，不因真实仓库根目录漂移而失败退出；因此即便极端情况下漂移提交绕过门禁进入 `main`，每日定时工作流 `upstream-watch.yml` 仍会通过离线逻辑单测并继续执行 `scripts/check-upstream-updates.py`，在受管 Issue 中将对应组件状态附加 `（本地配置漂移）` 并列出具体漂移项，同时不中断上游新正式版通知。

为什么只监控正式版 Release 的核心发布标识：

- `yt-dlp/yt-dlp` 与 `denoland/deno` 的默认分支每天都有大量常规提交，且可能存在草稿（`draft: true`）或预发布版本（`prerelease: true`，如 RC / canary）；而 `DokiTool-Go` 只固定采用官方正式版 Release 及其 SHA-256 摘要。
- 脚本仅请求 `GET /repos/{upstream}/releases?per_page=20` 与 `GET /repos/{upstream}/releases/latest`，将非草稿、非预发布的正式版归一化为确定性快照（`schema: 2`），并严格按 `(id, tag_name, published_at)` 判定正式版一致性与变更（不记录也不比对 `updated_at`，纯 Release 标题 `name` 润色或发布后补传构建产物不会触发误报噪音）。只有当上游正式版新增、标签/发布时间变更、正式版撤回或本地锁定配置漂移状态变化时才会触发通知。
- 早期 PHP 后端与 Vue 前端的来源归属继续保留在 `UPSTREAM.json` 与 [上游来源与维护方式](UPSTREAM-MAINTENANCE.md) 中，本工作流不会改写这些文件。

## 通知、状态保存与去重

- **专用跟踪 Issue**：首次成功运行会在 `Brilliant666/DokiTool-Go` 创建一个标题为 **`DokiTool-Go 上游运行时版本检查`** 的 Issue，指派给仓库所有者 `Brilliant666`，并在正文中输出版本对比汇总表（`组件 | 当前锁定版本 | 上游最新正式版 | 发布时间 | 状态`）及初始观察状态标记 `<!-- dokitool-upstream-watch-state:v2:... -->`。
- **增量评论与原子更新**：后续定时检查若未发现上游正式版 `(id, tag_name, published_at)` 变化或本地锁定漂移状态变化，不会写入任何评论；一旦发现上游发布新正式版、变更标签/发布时间、撤回正式版或本地配置漂移状态变化，会在同一 Issue 下发布一条包含最新汇总表、变更明细、升级提醒与最新 `v2` 状态标记（含 `local_drift`）的评论（同一请求原子提交）。若该 Issue 已被关闭，发现新变化时会自动重新打开后再追加评论。
- **状态可信边界**：脚本仅信任由 `github-actions[bot]` 创建的受管 Issue 及评论中的 `v2` 状态标记；人工评论不会被当作观察状态。若受管 Issue 缺失状态标记、机器人状态损坏、本地 Go 锁定常量缺失或格式非法，或任一 GitHub API 读取/写入未确认成功，脚本会抛出 `WatchError` 以退出码 `1` 失败退出（fail-closed），绝不推进观察状态或把失败误记为“无更新”。
- **手动验证通知通道**：在仓库 Actions 页面手动执行 **Watch upstream updates** 时勾选 `verify_notification`（对应命令行 `--verify-notification`），会向受管 Issue 发送一条明确标注为测试的验证评论；该评论不包含状态标记，不会改变真实观察状态。本地或只读调试可使用 `--dry-run`。

## 权限、安全边界与升级方式

- **最小权限**：工作流仅授予 `contents: read` 与 `issues: write`，`actions/checkout` 显式设置 `persist-credentials: false`，且仅在 `Brilliant666/DokiTool-Go` 的 `refs/heads/main` 分支运行。
- **零外部依赖与防注入**：脚本仅使用 Python 3 标准库，禁用 HTTP 重定向（`NoRedirect`）防止转发 `GITHUB_TOKEN`，严格限制 API 域名为 `https://api.github.com` 且仅允许向 `Brilliant666/DokiTool-Go` 的 Issues 端点发起受控写入；所有上游字符串（`tag_name`、Release 标题、时间戳）均经过 `safe_text` 转义，阻断 `@mention`、Markdown 链接/表格注入与 HTML 标签。
- **不下载、不自动升级**：此检查绝对不会下载或执行任何上游二进制、压缩包或源码，也不会自动创建 PR、修改仓库文件或触发部署。升级 `yt-dlp` 或 `Deno` 时，维护者需在经人工审查的 PR 中同步更新全部 5 处锁定文件中的版本号与官方 SHA-256 摘要（`backend/internal/ytengine/engine.go`、`backend/internal/platform/youtube/ejs_sandbox.go`、`.github/workflows/release-build.yml`、`.github/workflows/gateway-isolation.yml`、`scripts/requirements-validation.txt`），并通过全部离线与集成门禁。

## 调度限制与本地维护验证

GitHub 定时工作流可能因队列负载延迟执行，`09:00` 为计划触发时间而非精确到分钟的承诺。仓库连续 60 天无活动时，GitHub 可能自动暂停定时调度，届时可在 Actions 页面手动重新启用（参见 [GitHub 官方调度说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)）。

修改脚本、工作流、锁定版本或文档后，在本地执行以下离线验证：

```bash
python3 -B -m unittest discover -s scripts/tests -v
python3 -B scripts/check-upstream-updates.py --check-local-pins
python3 -B scripts/check-public-files.py --staged
```

暂停此检查可在仓库 Actions 页面禁用 **Watch upstream updates**，不影响线上解析与下载服务运行。
