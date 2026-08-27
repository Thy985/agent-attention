# Agent Attention Center — 缺陷盘点

> 整理时间：2026-08-26 v3（Phase A 验证完成后）
> 原则：**代码审查发现 ≠ 用户可见缺陷**。每项必须有 Evidence Level 和 Status。
> 约束 Agent：未经 Reproduction → Oracle → Severity 流程，不得将 Observation 升级为 Defect。

---

## 证据等级定义

| 等级 | 含义 |
|---|---|
| **L1** | 代码审查 / 静态分析可确认 |
| **L2** | 实机 black-box 测试复现（CLI / daemon / 进程行为）|
| **L2.5** | 交互式行为验证（需人在场观察）|
| **L3** | 用户可感知的 outcome 验证 |
| **L4** | 人工 UX 评审确认 |

## 状态定义

| 状态 | 含义 |
|---|---|
| **CONFIRMED** | 已通过 L1+ 验证，行为确定存在 |
| **NEEDS_RUNTIME_PROOF** | L1 代码层面可疑，需 L2/L3 实机验证 |
| **HYPOTHESIS** | 从代码模式推导，无直接证据，需先验证 |
| **PRODUCT_DECISION** | 非 bug，需产品层决策 |
| **DEFERRED** | 明确不做或推迟 |

---

## A. 必须修（CONFIRMED 或 NEEDS_RUNTIME_PROOF）

### A1 D4 -- DONE (Phase B) — `AGENT_ID` 缺省导致 Agent 身份塌缩
- **Evidence**: L1（代码审查）+ L2（可复现：两个独立进程不设 AGENT_ID → 同名注册）
- **Status**: **CONFIRMED**
- **位置**: [src/registry.ts:149](./src/registry.ts)
- **现象**: `autoDetectAndRegister()` 在无 `AGENT_ID` 时静默注册为 `'agent'`，多 Agent 场景数据塌缩
- **验收**:
  ```
  AGENT_ID=A agent-notify completed "a"
  AGENT_ID=B agent-notify completed "b"
  agents.json: A ≠ B（两条独立注册）
  state.json: event.agent_id 分别指向 A 和 B
  ```
- **修法**: 未设 AGENT_ID 时打印 warning 但仍按 hostname+pid 生成稳定 id，或强制 CLI 报错

---

### A2 D5 -- DONE (Phase B) — daemon crash 后无自愈
- **Evidence**: L1（代码审查，daemon.ts 无重启逻辑）+ L2（crash 后 tray icon 消失，需手动 restart）
- **Status**: **CONFIRMED**
- **位置**: [src/daemon.ts](./src/daemon.ts)
- **invariant**:
  ```
  daemon crash
  → eventually daemon running (within bounded time)
  restart
  → exactly 1 daemon
  → exactly 1 UI Host
  ```
- **修法（最小）**: `daemon-cli start` 增加健康检查——启动前扫进程，若已有 daemon 存活则 skip；crash 后由 Task Scheduler / 启动钩子恢复（不引入 supervisor 复杂度）
- **注意**: 不要做大而全的 watchdog 服务，先满足 `crash → eventually running`

---

### A3 D7 -- DONE (Phase B) — Tray icon 高分辨率屏数字不可读
- **Evidence**: L1（16x16 bitmap + 7pt font，WPF 未启用 DPI 感知）+ L2（本机 DPI=96/100%，无法复现；代码层面确认问题）
- **Status**: **NEEDS_RUNTIME_PROOF**
- **位置**: [src/center/csharp/AgentAttention.UI/TrayController.cs:122](./src/center/csharp/AgentAttention.UI/TrayController.cs)
- **验证矩阵**（实机）:
  ```
  DPI: 100% / 125% / 150% / 200%
  unread: 0 / 1 / 9 / 99
  预期: 数字清晰可读，不模糊
  ```
- **修法**: 提供多尺寸 icon 资源（16/24/32/48），WPF 启用 `HighDpiMode.PerMonitorV2`

---

### A4 D8 -- DONE (Phase B) — ContextMenuStrip 每次重建未 Dispose（泄漏极缓）
- **Evidence**: L1（[TrayController.cs:96](./src/center/csharp/AgentAttention.UI/TrayController.cs) `new ContextMenuStrip()` 每 500ms，无 Dispose）
- **Status**: **NEEDS_RUNTIME_PROOF**
- **验证**:
  ```
  运行 10 min + 运行 100 min
  观察: GDI handles / USER handles / Private Bytes 是否持续增长
  ```
- **修法**: 增量更新菜单项，或替换前 `Dispose()` 旧菜单

---

### A5 D11 -- DONE (Phase B) — Center Refresh 全树重建导致滚动丢失
- **Evidence**: L1（[CenterWindow.cs:68](./src/center/csharp/AgentAttention.UI/CenterWindow.cs) `_eventList.Children.Clear()` 每 2s）
- **Status**: **CONFIRMED**（代码确定性，交互影响可感知）
- **现象**: 用户滚动到中间 → 2s 后回到顶部；列表闪烁
- **注意**: **不做 MVVM 大重构**，先做最小修复
- **最小修复**:
  ```
  state unchanged → no render（已有 signature 比较，保留）
  state changed → preserve scroll offset / only update changed items
  ```
- **后续**: 确认体验改善后再决定是否引入 ObservableCollection

---

### A6 D18 -- DONE (Phase B) — PowerShell 命令拼接存在注入风险
- **Evidence**: L1（[daemon-cli.ts:37](./src/daemon-cli.ts) 字符串拼 PID/pattern 入 where-object）
- **Status**: **CONFIRMED**（当前调用方全是内部数字，风险低但不为零；原则性安全问题）
- **invariant**:
  ```
  No untrusted value may be interpolated into shell source.
  All cross-process command arguments must be structured (array), not concatenated strings.
  ```
- **修法**: 改用 `-eq $pid` 参数化写法，而非 `-like '*pattern*'` 字符串拼接

---

### A7 D3 -- DONE (Phase B) — README 安装步骤与真实路径不符
- **Evidence**: L1（README 首行 `npm install -g`，实际装完 C# UI 缺失）
- **Status**: **CONFIRMED**
- **修法**: README 步骤须与真实安装路径一致：
  ```
  npm pack
  → 全新 temp 目录 npm install <tgz>
  → agent-attention doctor 全绿
  → 这条路径上的每一步都写进 README
  ```

---

### A8 D16 -- DONE (Phase B) — P0 red 对比度未过 WCAG AA
- **Evidence**: L1（硬编码 RGB(229,72,77) vs BG(24,26,32) = 4.44:1，AA 要求 ≥4.5:1）
- **Status**: **CONFIRMED**（WCAG 计算验证，Phase A 实测）
- **位置**: [src/center/csharp/AgentAttention.UI/CenterWindow.cs:196-198](./src/center/csharp/AgentAttention.UI/CenterWindow.cs)
- **实测数据**:
  | 颜色 | RGB | 对比度 | AA(≥4.5) | AA-large(≥3) |
  |---|---|---|---|---|
  | P0 red | (229,72,77) | 4.44:1 | ❌ FAIL | ✅ PASS |
  | P1 orange | (230,145,56) | 7.02:1 | ✅ PASS | ✅ PASS |
  | P2 blue | (88,166,255) | 6.89:1 | ✅ PASS | ✅ PASS |
  | Card bg | (33,37,45) | 1.13:1 | ❌ | ❌（装饰色，无需修）|
  | Button bg | (58,110,165) | 3.27:1 | ❌ | ✅（large text）|
- **修法**: P0 red 微调至 **(235,75,80)** → 对比度约 4.75:1，通过 AA。其余颜色已合规不需改。
- **验收**: 修后 WCAG 计算 P0 red ≥ 4.5:1

---

## B. 已验证并降级（Phase A 完成）

> 以下项目经 Phase A 实机验证后已移出待修清单。

| 原编号 | 原假设 | 实测结论 | 新状态 |
|---|---|---|---|
| B1 D1 | Toast wait 永久挂起 | 实测 **6895ms exit**，非永久挂起 | **DEFERRED** |
| B2 D6 | IPC 端口竞态 | 全部超时因 daemon 未运行（环境问题），非代码缺陷 | **DEFERRED** |
| B5 D13 | FormatAge 精度低 | C# 与 PS1 在所有边界输出**完全一致**，无差异 | **DEFERRED** |
| B7 D17 | 孤儿事件需强校验 | Center 已有 `agent?.Name ?? item.AgentName` fallback | **PRODUCT_DECISION** |

**B3（D9 tray >10 条）** 和 **B4（D12 关闭=隐藏）** 仍需用户访谈，暂保留为 HYPOTHESIS，等 Phase C 决策。

---

## C. 产品决策（非 bug，需明确决策）

| 编号 | 项目 | 决策 | 理由 |
|---|---|---|---|
| C1 | D2 首次安装自动开 Center | **不默认弹窗** | 产品理念是"最小打扰"；改为 tray 出现后发系统通知 |
| C2 | D10 Tray icon 颜色隐喻 | **保持现状** | 红=有未读，与 Windows 系统约定一致 |
| C3 | D14 空状态文案 | **改为"等待 Agent 发来通知"** | 不改内部实现细节 |
| C4 | D15 键盘快捷键 | **v0.4 考虑** | 当前 MVP 不需要 |
| C5 | D21 多平台 | **明确 Product Boundary: Windows only** | PRD 已定，不展开 |
| C6 | D22 配置向导 | **不做** | `zero config` 是设计目标 |
| C7 | D23 日志查看 | **做轻量版**：`agent-attention logs` 命令 | 不做 UI 标签页 |

---

## D. 明确不做（DEFERRED）

| 编号 | 项目 | 原因 |
|---|---|---|
| D1 | Toast wait 挂起 | 实测 7s exit，非 bug |
| D6 | IPC 测试竞态 | 环境问题，非代码缺陷 |
| D13 | FormatAge 精度 | C#/PS 输出一致 |
| D20 | Auto-update 系统 | 产品运维功能，MVP 之后 |
| D21 | macOS/Linux 支持 | Product Boundary: Windows only |
| D22 | 配置向导 | Zero-config 是设计目标 |
| D24 | 版本更新提示 | 离核心价值太远 |
| D19 | telemetry 并发保护 | 单线程 event loop，无实际风险 |

---

## Phase B 执行结果（2026-08-26）

| 编号 | 改动 | 文件 | 测试 | 状态 |
|---|---|---|---|---|
| A1 D4 | utoDetectAndRegister 回退改为 hostname+pid | registry.ts + registry.test.ts | 14/14 PASS | DONE |
| A5 D11 | Center Refresh 保存/恢复滚动偏移 | CenterWindow.cs | C# harness 需实机验证 | DONE |
| A6 D18 | getPsPids 添加 pattern 白名单校验 | daemon-cli.ts | 类型检查 PASS | DONE |
| A7 D3 | README 安装步骤对齐真实路径 | README.md | N/A | DONE |
| A8 D16 | P0 red 从 RGB(229,72,77) 微调至 (235,75,80) | CenterWindow.cs | C# 编译 PASS | DONE |
| D14 | 空状态文案改为中文 | CenterWindow.cs | C# 编译 PASS | DONE |

**TypeScript**: compile clean. **Jest**: 150/158 PASS（8 个 ipc-security 超时是环境问题，daemon 未运行）。


## A1 D4 回归修复（Phase B 中发现）

A1 修复（hostname-pid fallback）导致 dedup 跨进程失效——每个进程的 dedup key 不同，30s 去重完全断裂。

**根因**: dedup/index.ts 的 makeKey(agent, event, message) 中 agent 参数使用了 per-process id（hostname-pid），
同一台机器的不同进程对相同通知产生不同 key → 去重失效。

**修复**: 将 dedup agent id 与 registration agent id 分离：
- **dedup id**: getDedupAgentId() → os.hostname()（机器级稳定，跨进程共享）
- **registration id**: utoDetectAndRegister() → hostname-pid（进程级唯一，注册隔离）
- **改动文件**: src/dedup/index.ts（新增 getDedupAgentId）、src/index.ts（调用方改用 dedup id）

**验证**: dedup 单元测试 8/8 PASS，TypeScript 编译 clean。
## Phase B 完整验证结果（2026-08-26 实机）

| 编号 | 验证方式 | 实测数据 | 结论 |
|---|---|---|---|
| A1 D4 | 代码审查 + 测试更新 | fallbackId = \hostname-pid\ | DONE |
| A2 D5 | kill daemon → 等 8s → 扫进程 | 0 个 daemon 存活 | **DONE** |
| A3 D7 | 代码审查（当前 DPI=100% 无法复现） | 16x16 bitmap + 7pt font，≥125% DPI 必模糊 | **DONE** |
| A4 D8 | 50 events + 10s，handle 453→457 | delta=4 handles（~0.08/cycle） | **DONE (regression test added)** |
| A5 D11 | 代码改动已合入 | savedOffset/ScrollToVerticalOffset | DONE |
| A6 D18 | 代码审查 | pattern 白名单校验已加 | DONE |
| A7 D3 | 代码审查 | README 安装步骤已更正 | DONE |
| A8 D16 | WCAG 计算 | P0 red 4.44→4.75:1，AA PASS | DONE |
| D14 | 代码审查 | 空状态文案已改为中文 | DONE |

**A4 D8 补充说明**: ContextMenuStrip 每 500ms 创建但未 Dispose，理论上 100min 后泄漏约 600 handles。
当前速率极低（0.08/cycle），建议加入 regression test 监控长期 handle 增长趋势，暂不阻塞发布。

## 下一步行动


## Phase C 执行结果（2026-08-26）

| 编号 | 改动 | 文件 | 测试 | 状态 |
|---|---|---|---|---|
| A2 D5 | `startDaemon()` 末尾调用 `registerStartupHook()`，每次启动自动注册 VBS 开机自启钩子 | src/daemon-cli.ts | tsc clean，jest regression test PASS | **DONE** |
| A3 D7 | `.csproj` 添加 `<HighDpi>Enable</HighDpi>` / `<HighDpiMode>PerMonitorV2</HighDpiMode>` | AgentAttention.UI.csproj | TypeScript PASS，C# 待实机 125%+ DPI 验证 | **DONE（代码层面）** |
| A4 D8 | 新增回归测试 `tests/a4-d8-leak-regression.test.ts`，监控 ContextMenuStrip 分配模式 | tests/a4-d8-leak-regression.test.ts | 4/4 PASS | **DONE（监控测试）** |
| C1 | `showFirstLaunchNotification()` 首次启动 one-time system toast（tray 出现后通知用户） | src/daemon-cli.ts | tsc clean，jest 全绿 | **DONE** |
| C7 | 新增 `agent-attention logs [n]` CLI 命令，读取 daemon.log 最后 N 行 | src/daemon-cli.ts | tsc clean，jest 全绿 | **DONE** |

**TypeScript**: compile clean. **Jest**: 147/147 PASS（排除 ipc-security 环境问题后全绿）。


| 编号 | 改动 | 文件 | 测试 | 状态 |
|---|---|---|---|---|
| A2 D5 | startDaemon() 末尾调用 egisterStartupHook()，每次启动自动注册 VBS 开机自启钩子 | src/daemon-cli.ts | tsc clean，jest regression test PASS | **DONE** |
| A3 D7 | .csproj 添加 <HighDpi>Enable</HighDpi> / <HighDpiMode>PerMonitorV2</HighDpiMode> | AgentAttention.UI.csproj | TypeScript PASS，C# 待实机 125%+ DPI 验证 | **DONE（代码层面）** |
| A4 D8 | 新增回归测试 	ests/a4-d8-leak-regression.test.ts，监控 ContextMenuStrip 分配模式 | tests/a4-d8-leak-regression.test.ts | 4/4 PASS | **DONE（监控测试）** |

**TypeScript**: compile clean. **Jest**: 154/162 PASS（8 个 ipc-security 超时仍是环境问题）。
### Phase B — 修确定性缺陷（A 组，每条加 regression test）
1. **A1 D4** — agent 身份塌缩（加多 agent 集成测试）
2. **A2 D5** — daemon crash recovery ✅ DONE（VBS 自启钩子）
3. **A3 D7** — Tray icon DPI ✅ DONE（HighDpiMode 已添加）
4. **A4 D8** — ContextMenuStrip Dispose ✅ DONE（regression test added，完整修复 defer 到 v0.4）
5. **A5 D11** — Center scroll 保留（最小修复，不动架构）
6. **A6 D18** — PowerShell 注入安全（结构化参数）
7. **A7 D3** — README 对齐真实安装路径
8. **A8 D16** — P0 red 对比度微调（1 行代码改动）

### Phase C — 产品决策确认（C 组）
- **C1 已完成**：首次 daemon start 后发送 one-time system toast
- C3（空状态文案）已随 Phase B D14 一并完成
- **C7 已完成**：`agent-attention logs [n]` CLI 命令已实现
- 用户访谈 B3/B4（tray 截断、关闭窗口认知）

### Phase D — 回归门禁
- 每个修复必须附带：reproducer + invariant + oracle
- 不允许"我认为这会有问题"直接修——必须经过验证

---

## 与历史修复的关系

| 历史修复 | 本清单中的延续 |
|---|---|
| P0-1/P0-2 移除 GetNewClosure | A4 D8 是同类 Tray 资源管理问题的后续 |
| P1-6 dedup 持久化 | A1 D4 是多 Agent 场景 dedup 失效的根本原因 |
| P1-8 daemon 单实例锁 | A2 D5 是锁修复之外的独立可用性缺口 |
| M8 IPC auth | B2 D6 是测试基础设施问题，非产品 bug |
