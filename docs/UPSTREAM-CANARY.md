# 上游低噪定时 Canary 巡检（Upstream Canary）

GitHub Actions 的 **Upstream canary probe**（[`.github/workflows/upstream-canary.yml`](../.github/workflows/upstream-canary.yml)）每 **12 小时**在 GitHub 托管的 `ubuntu-24.04` runner 上自动运行一次，用于及早发现 YouTube 播放器脚本变更（`tv` / `main` 变体回归）与线上核心只读接口异常，同时通过连续失败防抖、指纹去重与自动恢复关闭机制避免噪音刷屏。

## 调度计划与触发方式

- **定时计划**：`cron: '30 1,13 * * *'`（每天 UTC `01:30` 与 `13:30`，对应北京时间 `09:30` 与 `21:30`），与每日版本监控 [`.github/workflows/upstream-watch.yml`](../.github/workflows/upstream-watch.yml)（UTC `01:00`）错峰 30 分钟。
- **手动触发**：可在仓库 Actions 页面通过 `workflow_dispatch` 手动触发；勾选 `dry_run: true` 时仅执行探针与本地评估，**不向 GitHub Issue 写入任何创建、评论或关闭请求**。
- **运行边界**：仅在 `Daiobs/DokiTool-Go` 的 `refs/heads/main` 上执行；并发组 `dokitool-upstream-canary`（`cancel-in-progress: false`），总超时 `15` 分钟。

## 巡检探针组成

每次运行依次执行两组互补的只读探针，两组探针互不阻断，最终统一交由 [`scripts/check-upstream-canary.py`](../scripts/check-upstream-canary.py) 做 fail-closed 聚合判定：

### 1. 零权限 Deno / `yt-dlp/ejs` 实时兼容性探针（`tv` + `main`）

- 源码位于 [`backend/internal/platform/youtube/canary_live_test.go`](../backend/internal/platform/youtube/canary_live_test.go)，以 `//go:build canary` 编译标签隔离，默认 `go test ./...` 与 PR 离线门禁绝不访问外网。
- 使用与 [`.github/workflows/release-build.yml`](../.github/workflows/release-build.yml) 与 [`backend/internal/platform/youtube/ejs_sandbox.go`](../backend/internal/platform/youtube/ejs_sandbox.go) 一致的锁定 Deno `2.9.8`（严格校验 Linux x86_64 二进制 SHA-256 `368bca08999e02c6911b8f248167b582276b1f547db5712b6e736d7eda1dbda7` 与 `--version` 首行）及仓库锁定 `yt-dlp/ejs` 脚本资产。
- 探针拉取 `https://www.youtube.com/iframe_api` 获取当前 8 位十六进制 `player_id`，随后独立拉取并调用 `EJSSandbox.PreprocessAndProbePlayer` 验证 **`tv`（主路径）与 `main`（回退路径）两个变体**。
- `overall_ok` 要求 `tv_ok && main_ok`；状态字段明确区分：
  - `ok`：`tv` 与 `main` 均通过
  - `degraded_tv_only`：`tv` 失败、`main` 通过（主路径降级）
  - `degraded_main_only`：`tv` 通过、`main` 失败（如 `b485e332` 类 `main` 回退路径回归，提前预警）
  - `outage`：两个变体或 `iframe_api` / 沙箱初始化失败
- 通过 `DOKITOOL_CANARY_JSON_OUT` 仅输出封闭词表脱敏 JSON（仅含 8 位 `player_id`、布尔状态、大写 ASCII 错误码、耗时与版本号；严禁输出任何 URL、IP、原始 HTML/JS、Header 或 Cookie）。

### 2. 线上只读轻量冒烟（`platforms` / `youtube_context` / `api_boundary`）

- 执行 [`scripts/prod-smoke/smoke.py`](../scripts/prod-smoke/smoke.py)：
  ```bash
  python3 -B scripts/prod-smoke/smoke.py \
    --only platforms,youtube_context,api_boundary \
    --youtube-context-warn-ms 1500 \
    --youtube-context-fail-ms 5000 \
    --format json \
    --json-out "$RUNNER_TEMP/smoke-canary.json"
  ```
- 仅验证匿名公开只读边界与 `/api/youtube/context` 响应健康度；**不调用** `tier_b_platforms`，**不触发**突发限流，**不携带**任何 Cookie 或 `DOKITOOL_OWNER_TOKEN`。
- 跨太平洋延迟阈值（Guardrail G6）：
  - `<= 1500ms`：`PASS`
  - `1500ms < latency <= 5000ms`：`WARN`（记录于摘要表，不触发告警失败）
  - `> 5000ms`：`FAIL`（`LATENCY_FAIL`，计入 Canary 失败）

## 低噪防抖、去重与自动恢复闭环（Guardrail G6）

[`scripts/check-upstream-canary.py`](../scripts/check-upstream-canary.py) 仅依赖 Python 3.9+ 标准库，遵循以下状态机：

1. **连续 2 次失败防抖（Debounce）**：
   - 当本次 Canary 失败时，脚本通过 GitHub Actions API 读取 `upstream-canary.yml` 在 `main` 分支上最近完成的定时运行记录（仅统计 `event == 'schedule'`，忽略 `workflow_dispatch` 与 `cancelled`/`skipped`）。
   - **第 1 次孤立失败（`consecutive_failures == 1`）**：若当前没有已开启的告警 Issue，脚本会**静默抑制建单**（零写入），但仍以非零退出码（`1`）结束工作流，使 GitHub Actions 记录本次 `conclusion: failure` 供 12 小时后的下一次巡检计数。
   - **连续 ≥ 2 次失败（`consecutive_failures >= 2`）**：创建（或重新打开）唯一受管告警 Issue，指派给 `Daiobs`。
2. **唯一受管 Issue 与指纹去重**：
   - 告警 Issue 严格通过创建者 `github-actions[bot]`（`type: Bot`）及内嵌状态标记 `<!-- dokitool-upstream-canary-state:v1:<base64> -->` 识别（与版本检查 `#9` 的 `dokitool-upstream-watch-state:v2:` 完全隔离）；任何人工创建的伪造 Issue 或伪造评论标记均被严格忽略。
   - 告警开启期间，若后续运行的 16 位故障指纹（基于 `deno` 变体状态/错误码/`player_id` 与失败的 `smoke` 检查项 `(id, group, status, code, http_status)`，排除耗时与时间戳）未变化，则**去重跳过评论**，绝不刷屏；仅当故障指纹发生变化（如单变体降级扩大为全中断）时追加一条变更评论。
3. **恢复自动关闭**：
   - 一旦后续运行全部恢复通过且受管告警 Issue 仍处于开启状态，脚本追加一条脱敏恢复评论（携带 `recovered` 状态标记）并自动关闭该 Issue。
4. **报告缺失/损坏 Fail-Closed**：
   - 若任一探针报告文件缺失、JSON 格式损坏、字段自相矛盾、缺少必查分组或探针进程退出码非零，评估器一律按失败处理并参与防抖与非零退出，绝不静默放行。

## 安全红线与零新增 Secret 约束

- **零新增 Secret**：工作流仅使用 GitHub Actions 默认提供的 `GITHUB_TOKEN`，权限收紧至 `contents: read`、`issues: write`、`actions: read`；不使用 `DOKITOOL_OWNER_TOKEN`、不使用 Cookie、不启用 `persist-credentials`。
- **固定 SHA 引脚**：所有第三方 Action（`actions/checkout`、`actions/setup-go`）均固定至 40 位完整 commit SHA；Deno 2.9.8 二进制经官方 SHA-256 严格校验后才进入零权限沙箱（`--deny-net --deny-read --deny-write --deny-env --deny-run --deny-ffi --deny-sys --deny-import`）。
- **Fail-Closed 脱敏门禁**：`scripts/check-upstream-canary.py` 在渲染正文与发送任何 GitHub API 写入前均强制校验 `assert_desensitized`，拒绝任何含本机路径、IPv4/IPv6、令牌/认证头、签名查询参数（`sig=`、`upsig=`、`ticket=`、`ip=` 等）或非白名单 URL 的输出。
- **只检测不自动变更**：本巡检不会自动修改仓库代码、提交 PR 或触发生产部署；若告警确认由上游变更引起，仍须通过人工审查的 PR 与正式发布 Issue 处理（升级 Deno 版本时请同步核对本工作流中的版本与 SHA-256）。

## 本地离线验证

```bash
# 1. 编译检查与离线分类/脱敏单测（不访问 YouTube 外网）
(cd backend && go vet -tags canary ./internal/platform/youtube && go test -tags canary -run '^TestCanaryReport' ./internal/platform/youtube)

# 2. prod-smoke 与 canary 评估器离线单测
python3 -B -X utf8 -m unittest scripts/prod-smoke/test_smoke.py
python3 -B -X utf8 -m unittest scripts/tests/test_upstream_canary.py -v

# 3. 公开文件清单校验
python3 -B scripts/check-public-files.py --staged
```
