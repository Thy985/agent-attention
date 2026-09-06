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

## 5b. H2-0 执行证据（实机 L3，2026-09-06）

> H2-0（Real Windows Integration Gate）首轮完成。证据均为真实 Windows 环境（非 mock）。

| 验证项 | 结果 | 证据 |
|------|------|------|
| S1 self-contained 发布 | ✅ | `dotnet publish -r win-x64 --self-contained true` 产物含 `includedFrameworks`，在 `env -i`（无 DOTNET_ROOT/PATH dotnet）下可运行；`package.json publish:ui` 已改 self-contained |
| S3 daemon→UI 启动 | ✅ | UI 常驻、`ipc client connected`、`tray-state.json` 更新；修复了 daemon 对 exit code 0 无限重启的 bug（`code!==0` 才 respawn） |
| S4 tray/未读传播 | ✅ | 发送事件后 `state` 与 `tray-state` unreadCount 0→1 一致 |
| S5 Mark-All-Read | ✅ | mark 后 state 与 tray-state 双 0，all read=true |
| **S6 Target Jump** | ⚠️ **FAIL（根因定位）** | `daemon-cli jump` rc0 但 `GetForegroundWindow()` 未命中；根因：Windows 前台锁——Node 派生 PowerShell 子进程无法 `SetForegroundWindow`；**直接进程内调用则成功**。真实 L3 功能缺陷，需设计级修复 |
| S7 daemon restart→UI 恢复 | ✅ | restart 后 1 个新 UI（pid=8760）与 `tray.pid` 精确匹配 |
| S8 npm pack→clean install | ✅ | tarball 含 self-contained UI.exe；隔离 prefix 安装成功；installed `agent-notify` 执行并写 State |
| S9 全量回归 | ✅ | `npm test` 241/241（29 suites），`npm run build` clean，无回归 |

**H2-0 遗留**：S6 Jump FAIL 是当前唯一未达标验收项——把「点击跳回 Agent」从"死代码判定"抬升为"已测量的真实 L3 失败"；修复方向待评审（前台锁规避 `AllowSetForegroundWindow`/有前台权限进程 或 撤回 Jump 语义）。L5 不可自动化，待人工。

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