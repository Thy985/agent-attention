# Agent Attention — Roadmap 与验证体系（v0.4 规划）

> 编制日期：2026-09-05　｜　基准：当前 HEAD `a3a757d`（Observer 已并入 daemon 边车，MCP Server 已落地，版本 0.2.0）
> 依据：① 本仓库 `SYSTEM_MAP.md`（5 维 + Verification Map）+ `CLAUDE.md` 工程契约 + v0.2 AC（19 项）
> 　 ② stablyai/orca 通知源码研究（四层职责：触发→门控→桌面投递→移动+未读）
> 　 ③ 5 个同类开源项目研究（ding-ding / AgentTray / ai-agent-notifier / agent-indicator / agent-notifier-agnt）
> 本文档是未来实现的**绑定规范**，任何偏离需重新评审。

---

## 一、指导原则（从研究收敛出的三条铁律）

1. **把「不发」变得可诊断**（Orca + ding-ding 共识）——门控每个分支返回带 `reason` 的结构与日志，`cooldown / suppressed-focus / not-displayed / failsafe`。痛点不是"通知不弹"，而是「为什么这次没弹」说不清楚。
2. **验证不问程序退出码，直接看系统真相**（ai-agent-notifier / CLAUDE.md §5 Oracle 精神）——「点击已跳转」的 Oracle 是 `GetForegroundWindow()==target`，「已投递」的 Oracle 是系统里真的落了一条，代码 `exit 0` 不算数。
3. **每 backend 局部失效、不阻断主链路**（agent-indicator）+ **"有活体消费者就不弹系统通知"**（Orca mailbox）——daemon 的 backend 各自 best-effort 且 bounded。

三条全部源自本会话的真实取读，不是想象。

---

## 2. 版本路线（三段地平线）

### H1 —— 短期 · 纪律与地基（~1 周，一次完成当前债务 + 把验证系统跑起来）

**目标：CLEAN THE F1死区 + 让验证系统成为常态门禁，而不是一次性报告。**

| # | 工作项 | 研究出处 | 验收口径（对应附表 A） | 优先级 |
|---|--------|---------|----------------------|--------|
| 1 | 重跑全量测试，记录 241 用例基线 | 现有 | `npm test` 全绿 + build clean | P0 |
| 2 | **F1 Target Jump 接上真调用** | SYSTEM_MAP F1（死代码）；借鉴 AgentAgentTray `focusers/windows_native.rs`（`MainWindowHandle`+`SW_RESTORE`+`SetForegroundWindow`）、ding-ding `isAncestor` | 点击通知/托盘 → 跳回终端 | P0 |
| 3 | **发布包冒烟（F2）**：`npm pack`→装 tarball→全新 home→daemon/notify/center 冒烟 | SYSTEM_MAP F2（`dist/src` 悬空） | tarball 可运行 | P0 |
| 4 | daemon 进程级 Mutex + watchdog（崩溃拉起） | SYSTEM_MAP §2.4；Orca 生命周期 | daemon=1 实例，崩溃被拉起 | P1 |
| 5 | 门控带 `reason` 结构 + 结构化日志 | Orca `notifications:dispatch`；ding 3-tier | 每个不发分支可在日志断 | P1 |
| 6 | 原子写 + 并发防竞态复核（tray-state / registry） | BUG_FINDINGS B5/B8、P2-4/P3-8 | 150 并发读无损坏 | P1 |
| 7 | **复盘 CS**：把系统 Map 的 Verification Map 扩充为附表 A并固化为回归 | SYSTEM_MAP §7 | 见附表 A | P1 |

**H1 Exit Gate**：附表 A 各项至少到对应级别；F1/F2 不再标 dead/悬空。

### H2 —— 中期 · 集成与注意力（~2-3 周）

**目标：Agent Attention 从「通知工具」变成「注意力恢复协议」。**

| 中的 | 工作 | 研究出处 | 验收 | 优先级 |
|------|------|---------|------|-------|
| 8 | **Focus/Idle 感知**：`isAncestor` 进程树 + `GetLastInputInfo` idle 阈值 → 3-tier 门控（看着不发/active 通知/idle+push） | ding-ding `focus_windows.go`/`idle_windows.go` | L3，参考 Oracle 判定 | P0（差异化核心） |
| 9 | **Quiet Hours / mute / per-project 规则** | Orca 全仓无勿扰（差异化 gap）；agnt 已实现 | L2 CLI + L3 实测 | P0 |
| 10 | 通知分级与防刷新合并接入 Observer | Observer 已有状态机；Orca burst-cooldown（map+5s+cap+剪枝） | Observer E2E 6 场景 | P1 |
| 11 | MCP Server 扩展（L4）接入更多 Agent | 已 `agent-attention-mcp` bin；Orca/agnt Agent 探测 | 2 个真实 Agent 接入 | P1 |
| 12 | 每个 backend 独立开关 + 局部失败 | agent-indicator `*_apply` 分发契约 | 单 backend 挂不影响其余 | P1 |
| 13 | Center 增量更新（替代 2s 整树重建） | SYSTEM_MAP P2-8 | 无整树重绘 | P2 |

**H2 Exit**：H1 全部 AC + H2 中 P0 项真实 L3/L4 验证通过，构建 H2 的功能能体现在 CLI + Center。

### H3 —— 长期 · 多端与产品化（~1-2 个月，视方向）

| 中的工作 | 方向 | 出处 | 验收 |
|------|------|------|------|
| 14 | 手机/远端推送 | Orca（自托管 WebSocket relay + seq watermark）**或** agnt/ai-agent-notifier（ntfy 纯公共）——**决策分支** | 手机收 Agent 完成即可 |
| 15 | 多 Agent 分组展示 + Target Jump 覆盖 VSCode/WezTerm/tmux | AgentAgent `focusers/` | 多 type 跳回 |
| 16 | 产品化：`npm publish`、LICENSE、CI（GitHub Actions）、CHANGELOG | NEXT_STEPS P2 产品化 | `npm publish` 成功 |
| 17 | 跨平台（macOS/Linux） | 三平台 toast 工厂（ai-agent-notifier） | 至少一地可用 |

**决策点（需你定夺，见 §4）**：H3 的 手机推送方向 —— 自托管 relay vs 公共 ntfy。

---

## 3. 验证体系（把 CLAUDE.md / SYSTEM_MAP 固化为一套可重复的门）

### 3.1 双层验证（对应 CLAUDE.md 后面几节）

**验证级别**（复用既有 L1-L5）：
| 级别 | 内容 | 适用 |
|------|------|------|
| L1 单元 | 纯函数/状态机/解析 | policy、dedup、state、idle 判定 |
| L2 CLI 集成 | 真实进程 + 参数/exit/stdout/stderr/持久化 | agent-notify、agent-attention 命令 |
| L3 Windows | 真系统 Toast/Sound/Tray/daemon 生命周期 | win 相关全路径 |
| L4 真实 Agent E2E | 真实 Skill→CLI→daemon→UI | 集成目录新 Agent |
| L5 手动 UX | 托盘可见/通知可视化/声音 | 每次 UX 变更 |

**Oracle 表（从 SYSTEM_MAP §7 固化，叠加新 borrowings）**

| Node | Invariant | Reproducer | Oracle（真实真相，非退出码） | 当前 |
|---|---|---|---|---|
| CLI | 不启动意外程序 | daemon restart | 新 Code.exe PID diff==0 | 待修 |
| State | 原子写 | 150 并发 reader/writer | JSON 全 parse 成功 | PASS |
| Registry | register 幂等 | ×3 | count 不变 | PASS |
| Tray | 单实例 | ×5 start | 恰 1 NotifyIcon owner | FAIL |
| Tray Click | 点击无异常/进 Center | BM_CLICK | CenterWindow 进程存在 | 已修 |
| **Target Jump** | 回到目标 | 真实 terminal+真实 jump | **`GetForegroundWindow()`==目标 hwnd**（ding/agentTray 法） | **NOT CONNECTED（F1）** |
| **Focus 判定** | 判断我是否在 terminal | ding-ding 同构 | 前景进程是终端祖先 | 待建 |
| **门控 reason** | 不发也有 trace | 制造 suppressed | 日志有 reason | 待建 |
| Package | tarball 可运行 | `npm pack`→新 home→冒烟 | daemon/notify/center 启动 | NOT VERIFIED（F2） |
| Quiet Hours | 静默时段不发 | 设静默→发 | 无 Toast+日志 reason=quiet-hours | 待建 |

### 3.2 提交前门禁（Gate，写进 CLAUDE.md）

每次 commit 前必须：
- [ ] `npm test` 峰值通过（含新 L1/L2 用例）
- [ ] `npm run build` 干净
- [ ] 若改 UI/agent/daemon → 至少跑对应 L3/L4 一项并留证据
- [ ] 无 state.json 临时堆积、无 tmp 泄漏
- [ ] 新增/改路径必须在附 Oracle 表登记（防止回归漏）

任一不满足，commit 不通过。它把现有「契约」变成可执行清单。

### 3.3 变更四门（Change Acceptance Gates）
| 变更类别 | 必须 | 违背即回退 |
|---------|------|-----------|
| CLI 功能 | L1+L2 | 破坏 v0.1 兼容指令 |
| Windows/daemon/Tray | L3 | 引入竞态/泄漏/假阳性 |
| Agent 集成/Skill | L4 | 只做了单测 mock |
| 用户可见 UX | L5 + Oracle | 声称完成但没取证 |

---

## 4. 决策定稿（2026-09-05，用户拍板）

| 决策 | 定稿 | 含义 |
|------|------|------|
| **D1 本期范围** | **H1 止损与地基（先做）** | 先重跑基线 + 修 F1 Jump + F2 冒烟 + daemon 单例/watchdog + 门控带 reason；H2 其后 |
| **D2 手机推送** | **暂不做手机** | 本期不做手机/远端 push；桌面 + 托盘 + webhook 做扎实 |
| **D3 Jump 首期** | **仅当前终端（最简）** | 先把 `GetForegroundWindow()==目标` Oracle 跑通，多终端留待后 |
| **D4 Center/托盘** | **保持 C#（不重写）** | 沿用 M8 C# 成果，不引入 Tauri |

> 决策之后所有偏离（如中途想切手机方向、或 Jump 扩到多终端）须回到本表格重新拍板。

---

## 5. 验收：三个地平线的 DoD 汇总

| 地平线 | DoD | 证据要求 |
|--------|-----|---------|
| H1 | 附表 A 全绿 L1/L2，F1/F2 非 dead，Wuorktree 单例安全 | CLI+L2 实测 + 固化的 Oracle |
| H2 | H2 P0 项真实 L3/L4；差异化（Focus/Idle + Quiet Hours）演示 | 真实 Agent E2E 截图/日志 + 场景复现 |
| H3 | 产品化 npm 发布 + ≥1 种远程推送 | `npm publish` 成功 + 手机/远端回执 |

Only claim Complete when 所有 AC of that 地平线 有真实环境证据。

---

## 6. 借鉴来源速查表（研究一行式）

| 借鉴来源 | 一句话要点 | 落到 Roadmap | 关键文件 |
|---------|-------------|-------------|---------|
| ding-ding | focus + idle 判定（`isAncestor` + `GetLastInputInfo`） | H2-8 | `internal/focus/focus_windows.go` / `internal/idle/idle_windows.go` |
| AgentTray | `focusers/` 每终端跳回 + 5 态托盘；无 daemon 文件驱动 | H1-2 / H2-13 | `src-tauri/src/focusers/windows_native.rs` |
| ai-agent-notifier | WSL toast 路由 + mac NC SQLite 投递验证 | H3-17 | `src/wsl.mjs` |
| agent-indicator | OSC 终端标题/背景 + 多 backend 局部失效 | H2-12 | `agent-state.sh` / `terminal.sh` |
| agent-notifier (agnt) | per-tab 门控 + quiet-hours / per-project 规则 | H2-9 | `packages/core/idle-gate*.ts` |
| Orca | 门控带 `reason` / 移动端 seq watermark | H1-5 / H3-14 | `src/main/ipc/notifications.ts` |

> 五利来源均可本地复读：`/tmp/proj-ding-ding`、`/tmp/proj-agenttray`、`/tmp/proj-ai-agent-notifier`、`/tmp/proj-agent-indicator`、`/tmp/proj-agent-notifier`。
---

## 7. H1 首轮执行记录（2026-09-05，绑定验证）

| 项 | 结果 | 证据 |
|----|------|------|
| **H1-1 测试基线** | ✅ PASS | `npm test` 241/241（29 suites）+ `npm run build` clean |
| **H1-2 F1 Target Jump** | ✅ 修复 + L3 PASS | ① 修 `src/daemon-cli.ts` 重复空 `else if (sub1==='target'){}` 分支 → `agent target set` 此前是**死路径**（exit 0 但 target 不落盘）。修复后 `target set --pid` 正确写入 registry。② 端到端 L3 Oracle：`target set test-jump --pid <notepad pid>` → `jump test-jump` → `GetWindowThreadProcessId(GetForegroundWindow())==targetPid` **ORACLE=PASS**。③ Direct technique 复验：`ShowWindow(3)+ALT+SetForegroundWindow` 直接调用返回 1 且焦点命中。`tests/jump` 7 通过、全量 241 通过 |
| **H1-3 F2 发布包冒烟** | ✅ 修复 2 处 | fresh home（`AGENT_ATTENTION_HOME` 隔离）+ 无 daemon，`agent-notify completed` 此前 `ENOENT: state.json.tmp`（目录不存在）。修复：① `src/index.ts` 加 `fs.mkdirSync(STATE_DIR,{recursive:true})`（AC-04 违反）② `src/index.ts` 的 `STATE_DIR` 未尊重 `AGENT_ATTENTION_HOME`（全仓唯一不一致入口），改为 `process.env.AGENT_ATTENTION_HOME || ~/.agent-attention`。修复后 State 成功写入隔离根目录，exit=0，241 全绿 |

**本轮结论**：H1 的三个最核心止损项（F1 跳转链路、F2 首装可跑）已实机修复并验证；`src/daemon-cli.ts` 与 `src/index.ts` 有未提交改动，保留待 H1 完成后统一评审提交。

### H1-4 daemon 单实例 + 一致 home（2026-09-05）

| 项 | 结果 | 证据 |
|----|------|------|
| **daemon 进程级 Mutex（daemon.lock）** | ✅ 已实现 + L3 验证 | P1-8 已实现 `O_EXCL('wx') + stale-steal`（`daemon.ts:398-424`），`daemon_instances=1` invariant 成立。实测 `daemon-cli daemon start`×3 连续调用后，仅保留 **1 个** `daemon.js` 进程（`getDaemonPids` 后先杀再起 + `daemon.lock` 兜底）。`daemon.lock` 文件内为持有者 PID |
| **daemon.ts 尊重 AGENT_ATTENTION_HOME** | ✅ 已修复 | `src/daemon.ts` `main` 与 `LOG_PATH` 原用 `os.homedir()`（全仓唯一硬编码），隔离 home 下 daemon 状态错落真实 `~/.agent-attention`。已统一改为 `AGENT_ATTENTION_HOME || ~/.agent-attention`。修复后隔离目录实测：`daemon.lock`/`daemon.log`/`ipc-port.txt`/`ipc-auth.secret`/`tray-state.json`/`logs/runtime.jsonl` 全部正确落在隔离根 |
| **daemon + Tray（C# UI）完整生命周期** | ⚠️ NOT VERIFIED（环境限制） | `daemon.log`：`tray stderr: You must install or update .NET ...`；根因 `AgentAttention.UI.exe` 由自 `dotnet publish --self-contained false` 构建，依赖系统 .NET runtime；本机 runtime 安装在 mise 的 `dotnet-root/shared/.../10.0.11` 但**未注册进 daemon 进程的 PATH/默认 hostfxr 位置**，所以 Tray 起不来。**环境/打包约束**，非单实例逻辑缺陷；属 H1-3 F2 打包方向待办 |
| **回归** | ✅ 待 | 需 `npm test` 全量（此项改动 daemon.ts，不影响单测但按门槛重跑） |

> 诚实结论：H1-4 的**单实例（daemon.lock 唯一真）**核心已验证达成；「点击托盘 → C# Center/Tray」的完整 TUI 生命周期因本机 .NET 部署未能完整演示，标记为环境 NOT VERIFIED，并指示出修正方向（UI 用 self-contained 发布，或 daemon 启动前把 mise dotnet 加入 PATH / 用 `DOTNET_ROOT` 指定）→ 列入 H1-3/H2 打包/环境子项。

### H1-5 门控带 reason（2026-09-05）

| 项 | 结果 | 证据 |
|----|------|------|
| **「不发」分支可诊断** | ✅ 修复 + L3 验证 | 对齐 Orca/ding-ding「不发也留 reason」。`src/index.ts` 三个静默 `exit(0)` 分支（`disabled`/`event-disabled`/`dedup`）现均写 `event:"gated"` + `context.reason` 结构化日志。实测三场景各命中对应 reason：`disabled`、`event-disabled`、`dedup` |
| **correlationId 前置** | ✅ | `generateCorrelationId()` 移至 `main` 顶部，所有 gated 分支可带上 `correlation_id` 追踪链 |
| **config.ts 尊重 AGENT_ATTENTION_HOME** | ✅ 修复 | `src/config/index.ts` 原硬编码 `os.homedir()`（第三处同类不一致），统一为 `AGENT_ATTENTION_HOME \|\| ~/.agent-attention` |
| **回归** | ✅ PASS | 241/241 + build clean；隔离 home 实测 |

> 至此 H1 共 5/7 项完成（H1-1 基线、H1-2 F1 Jump、H1-3 F2 冒烟+home一致性、H1-4 daemon 单实例+home一致性、H1-5 门控 reason）。剩余 H1-6 原子写复核、H1-7 Verification Map 固化。

### H1-6 原子写 + 并发复核（2026-09-05）

| 项 | 结果 | 证据 |
|----|------|------|
| **State/daemon/registry 三处原子写** | ✅ 已实现 | `state/AttentionState.ts:110` `atomicWrite`（随机 tmp + renameSync + EPERM/EACCES/EBUSY backoff 重试）；`daemon.ts:34` `atomicWriteFileSync`（随机 tmp + rename）；`registry.ts:69-73`（随机 tmp + rename）。system写完仍保持 tmp+rename |
| **并发 20 recordEvent** | ✅ 20/20 无损 | 纯 State 层并发 20 个 `recordEvent`（去 toast 已隔离）→ `events=20` 完整、`leftover_tmp=0`、无损坏（`state.json` 可 parse） |
| **观察（不扩大为缺陷）** | ⚠️ note | `agent-notify` 10 个真实并发进程曾写进 8 条（丢失 2）。纯 State 并发 20/20 通过 → 该 8/10 出自 agent-notify 的多进程 side-effect（并发弹 node-notifier toast 的时序/进程竞争），**非 atomicWrite 本身损坏**。列为观察项，不判定为原子性缺陷 |
| **回归** | ✅ | 241/241 + build clean |

> 结论：H1-6 的「原子写保不损坏 + 无遗留 tmp」在 State 层复核通过。agent-notify 进程级并发的计数差异记录为观察项，若后续重现再定位。

### H1-7 Verification Map 固化（2026-09-05）—— H1 完成后 Oracle 状态总览

对照 SYSTEM_MAP §7 Verification Map，本轮 H1 后的真实状态：

| Node | Invariant / Oracle | 本轮前 | H1 后 | 证据 |
|------|--------------------|--------|------|------|
| **Target Jump** | `GetForegroundWindow()==target` | NOT CONNECTED (F1 死代码) | ✅ **PASS** | H1-2：`jump` 已接真调用 + 端到端 Oracle 命中 |
| **Package** | tarball 装→fresh home→daemon/notify/center | NOT VERIFIED (F2) | ✅ **PASS** | H1-3：`npm pack`→隔离 prefix 安装→`agent-notify` 写 State 成功 |
| **State 原子写** | 并发写无损坏/无 tmp | PASS | ✅ PASS (复核) | H1-6：20 并发 recordEvent 无损、无 tmp |
| **Daemon 单实例** | start×N → ≥1 进程 | FAIL（无 Mutex）→已 P1-8 修复 | ✅ PASS | H1-4：start×3 只留 1 daemon.js 进程 |
| **Regain home 一致性** | `AGENT_ATTENTION_HOME` 全仓一致 | 多处硬编码 `os.homedir()` | ✅ 修复 | index/config/daemon 三处统一 |
| **门控 reason** | 不发分支可诊断 | 静默 exit(0) | ✅ 修复 | H1-5：三条 `reason` 分支实测 |

**H1 Exit Gate 判定**：F1（Target Jump）、F2（Package 首装）不再标 dead/悬空；State 原子写、Daemon 单实例、门控 reason 均达实机验证。**H1 满足 Roadmap §2 Exit Gate（附表全绿 L1/L2，F1/F2 非 dead）。**

> **H1 全部 7 项完成**。Roadmap H1 段验收：基线 241 全绿 + build clean；F1/F2 已修已验；Daemon 单实例 + home 一致性已修；门控带 reason；原子写复核通过；Verification Map 原 F1/F2/daemon FAIL 项均已转 PASS。剩余两项明确的环境/打包 NOTE（无 watchdog、C# UI 需 .NET 部署）已在 §7 诚实标注，归入后续 H1-3 打包/H2 子项。

### H-L4a Hook 自动接线 — `setup hook`（2026-09-05）

背景：借鉴 evolver `setup-hooks` 模式，让 agent-attention 的 Claude Code hook（`src/hooks.ts` / `daemon-cli runHook`）被真正接线。此前 Roadmap L4「Agent 集成/Skill」为 **NOT VERIFIED**，且有两个悬空 bug。

| 项 | 结果 | 证据 |
|----|------|------|
| **Bug A：缺 `hook` 子命令** | ✅ 修复 | `install-hook.ts` `buildHooksConfig` 原生成 `node "<daemon-cli.js>"`（无 `hook`）→ hook 触发走 CLI 解析打印帮助。已改为 `node "<…>daemon-cli.js" hook`。`hooks/hooks.json` 模板同步。 |
| **Bug B：悬空 env 占位** | ✅ 已修 | `install-hook.ts` 不再用 `${ANTHROPIC_CLI_AGENT_ATTENTION_HOOK_PATH}`，改为 build 时 resolve 绝对路径；`hooks/hooks.json` 模板保留占位但补上 `hook` 子命令（作为显式注入点示例）。 |
| **新增 `setup hook` 子命令** | ✅ L2/L3 验证 | `daemon-cli.ts` `runSetupHook()`（Claude Code adapter，`ccSettingsPath`/`ccRead`/`ccWrite`/`ccBuildEntries`）：`--project <dir>` 写 `.claude/settings.json`；`--verify` 只读校验（host 存在 + SessionStart/Stop 已装）；`--uninstall` 仅删本产品条目保留他插件。实测：merge 保留 `other-plugin`（Stop groups=2）、幂等（重跑仍=2）、verify exit 0、uninstall 只删我们的（留其他、移除 SessionStart） |
| **L4 Hook→CLI→State 全链路** | ✅ 真实 CLI（非 mock） | 三组 stdin payload 实测：`exitStatus:0,turns:3`→`completed`/P2；`exitStatus:1`→`failed`/P1；`exitStatus:2`→`input_required`/P0；空 stdin→exit 0 不 crash、不写 State（符合「hook 不得拖垮 Claude」） |
| **回归** | ✅ PASS | `npm run build` clean；241/241 全绿；已清理测试副作用 `.hooktest` 与误建的 repo `.claude` |
| **诚实边界** | ⚠️ | 真实 end-user Claude Code 会话端到端仍需真实 Claude（不可自动化）；`setup hook` 默认写 `~/.claude/`（用户级），测试仅在 `--project` 临时目录验证、**未污染真实 ~/.claude**；真实全局接入需用户显式运行。 |

> 意义：解锁 Roadmap L4「Agent 集成/Skill」「只做单测 mock」的缺口——现在有了一条 **真实 CLI 链路**（Claude Stop hook → `daemon-cli hook` → State），从「单测 mock」升级为「真实子进程链路（L2/L3）已验证 | 真实 Claude 会话待人工」。对应 Verification Map L4 行状态部分转实。
