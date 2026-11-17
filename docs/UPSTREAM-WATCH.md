# 上游运行时版本每日检查

GitHub Actions 的 **Watch upstream updates**（[`.github/workflows/upstream-watch.yml`](../.github/workflows/upstream-watch.yml)）在 GitHub 托管的 runner 上运行，无需维护者的本地电脑保持开机。计划为每天北京时间 **09:00**（UTC `01:00`），也可以在仓库 Actions 页面通过 `workflow_dispatch` 手动触发。

## 监控对象与本地基线对比

`DokiTool-Go` 在生产环境锁定了经 SHA-256 严格校验的外部运行时版本。脚本 [`scripts/check-upstream-updates.py`](../scripts/check-upstream-updates.py) 直接从仓库 Go 源码读取当前锁定版本，并与两个上游仓库的**公开正式版 Release**（`draft: false` 且 `prerelease: false`）进行对比：

| 上游仓库 | 本地锁定常量位置 | 版本比对规则 |
| --- | --- | --- |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | `backend/internal/ytengine/engine.go` 中的 `const PinnedVersion`（如 `2026.10.26`） | 直接与上游最新正式版 `tag_name` 比对 |
| [denoland/deno](https://github.com/denoland/deno) | `backend/internal/platform/youtube/ejs_sandbox.go` 中的 `PinnedDenoVersion`（如 `2.9.8`） | 去掉上游正式版标签前导 `v`（如 `v2.9.8` → `2.9.8`）后与本地锁定版本比对 |

为什么只监控正式版 Release：

- `yt-dlp/yt-dlp` 与 `denoland/deno` 的默认分支每天都有大量常规提交，且可能存在草稿（`draft: true`）或预发布版本（`prerelease: true`，如 RC / canary）；而 `DokiTool-Go` 只固定采用官方正式版 Release 及其 SHA-256 摘要。
- 脚本仅请求 `GET /repos/{upstream}/releases?per_page=20` 与 `GET /repos/{upstream}/releases/latest`，将非草稿、非预发布的正式版归一化为确定性快照（`schema: 2`）。只有当上游正式版新增、编辑或撤回时才会触发通知，日常分支提交与预发布构建不会造成噪音。
- 早期 PHP 后端与 Vue 前端的来源归属继续保留在 `UPSTREAM.json` 与 [上游来源与维护方式](UPSTREAM-MAINTENANCE.md) 中，本工作流不会改写这些文件。

## 通知、状态保存与去重

- **专用跟踪 Issue**：首次成功运行会在 `Brilliant666/DokiTool-Go` 创建一个标题为 **`DokiTool-Go 上游运行时版本检查`** 的 Issue，指派给仓库所有者 `Brilliant666`，并在正文中输出版本对比汇总表（`组件 | 当前锁定版本 | 上游最新正式版 | 发布时间 | 状态`）及初始观察状态标记 `<!-- dokitool-upstream-watch-state:v2:... -->`。
- **增量评论与原子更新**：后续定时检查若未发现正式版变化，不会写入任何评论；一旦发现上游发布新正式版、编辑已发布正式版或撤回正式版，会在同一 Issue 下发布一条包含最新汇总表、变更明细、升级提醒与最新 `v2` 状态标记的评论（同一请求原子提交）。若该 Issue 已被关闭，发现新变化时会自动重新打开后再追加评论。
- **状态可信边界**：脚本仅信任由 `github-actions[bot]` 创建的受管 Issue 及评论中的 `v2` 状态标记；人工评论不会被当作观察状态。若受管 Issue 缺失状态标记、机器人状态损坏、本地 Go 锁定常量缺失或格式非法，或任一 GitHub API 读取/写入未确认成功，脚本会抛出 `WatchError` 以退出码 `1` 失败退出（fail-closed），绝不推进观察状态或把失败误记为“无更新”。
- **手动验证通知通道**：在仓库 Actions 页面手动执行 **Watch upstream updates** 时勾选 `verify_notification`（对应命令行 `--verify-notification`），会向受管 Issue 发送一条明确标注为测试的验证评论；该评论不包含状态标记，不会改变真实观察状态。本地或只读调试可使用 `--dry-run`。

## 权限、安全边界与升级方式

- **最小权限**：工作流仅授予 `contents: read` 与 `issues: write`，`actions/checkout` 显式设置 `persist-credentials: false`，且仅在 `Brilliant666/DokiTool-Go` 的 `refs/heads/main` 分支运行。
- **零外部依赖与防注入**：脚本仅使用 Python 3 标准库，禁用 HTTP 重定向（`NoRedirect`）防止转发 `GITHUB_TOKEN`，严格限制 API 域名为 `https://api.github.com` 且仅允许向 `Brilliant666/DokiTool-Go` 的 Issues 端点发起受控写入；所有上游字符串（`tag_name`、Release 标题、时间戳）均经过 `safe_text` 转义，阻断 `@mention`、Markdown 链接/表格注入与 HTML 标签。
- **不下载、不自动升级**：此检查绝对不会下载或执行任何上游二进制、压缩包或源码，也不会自动创建 PR、修改仓库文件或触发部署。升级 `yt-dlp` 或 `Deno` 时，维护者需在经人工审查的 PR 中同步更新版本号与官方 SHA-256 摘要（`backend/internal/ytengine/engine.go`、`backend/internal/platform/youtube/ejs_sandbox.go` 及 `.github/workflows/release-build.yml`），并通过全部离线与集成门禁。

## 调度限制与本地维护验证

GitHub 定时工作流可能因队列负载延迟执行，`09:00` 为计划触发时间而非精确到分钟的承诺。仓库连续 60 天无活动时，GitHub 可能自动暂停定时调度，届时可在 Actions 页面手动重新启用（参见 [GitHub 官方调度说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)）。

修改脚本、工作流或文档后，在本地执行以下离线验证：

```bash
python3 -B -m unittest discover -s scripts/tests -v
python3 -B scripts/check-public-files.py --staged
```

暂停此检查可在仓库 Actions 页面禁用 **Watch upstream updates**，不影响线上解析与下载服务运行。
