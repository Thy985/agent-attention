# 系统运行地图（SYSTEM_MAP）

> 设计原则：不画 `CLI → Daemon → Tray` 的线性图，而是沿 **5 条正交维度** 刻画系统。每条维度都能**独立**暴露一类 invariant 违规——这是 Agent 工程方法的核心：地图的价值不在"画得像"，而在"能指出哪里坏"。
>
> 本文档扎根于当前源码实读（10 个核心文件）+ 3 项实机验证：
> - PowerShell 实测：本地 `.GetNewClosure()` scriptblock 内 `$using:StatePath` 抛 `NullReferenceException`（对应 TrayIcon.ps1:135-138/167/207）。
> - PowerShell 实测：`Get-TimeAgo` 24h+ 分支 `"${[math]::Floor($hours/24)}d ago"` 渲染为 `[d ago]`（数字缺失，对应 CenterWindow.ps1:65-75）。
> - Bash 实测：`dist/src DOES NOT EXIST`；Grep：`jumpToTarget` 在 `src/` 下零生产调用（死代码）。
>
> **校正说明（2026-08-21 第二轮）**：经一轮评审校正，以下发现**不再混为一谈**。架构上合理的选择（文件即本地共享事实源、Center 只读视图、Registry 与 State 分属不同 bounded context）**不算 bug**，不应据此重构；只有"真实交互路径已被证伪 / 发布包不可运行 / 架构承诺与实现背离"才列入优先修复。详见 §6 二分类与 §7 Verification Map。

---

## 维度总览

| 维度 | 回答的问题 | 能暴露的失效 |
|---|---|---|
| **Data Flow** | 数据从哪到哪、谁读什么 | 死代码分支、发布包路径悬空、双事实源是否需一致性契约 |
| **Control Flow** | 谁控制谁、实例数 invariant | "11 个 Tray"、daemon/tray 多实例、孤儿进程、crash 后恢复策略 |
| **State Flow** | 系统有哪些状态、怎么迁移 | 状态机是否替恢复器背职责、哪些 lifecycle 状态是过度基础设施化 |
| **Boundary** | 每个组件负责什么 | 越界（写）vs 合理（只读）的判定 |
| **Oracle Flow** | 每个结果怎么证明 | "点击已跳转"伪证、"全部已读"伪证、菜单点击静默失败 |

---

## 1. Data Flow（数据从哪里到哪里）

```
[Agent / Skill / CLI]
        │  (spawn child, env: AGENT_ID / AGENT_NAME)
        ▼
[CLI Runtime  = src/index.ts :: main()]
        │ ① recordEvent(STATE_PATH, ...)  → 直写 state.json        ★ 不经 daemon（合理，见 §6.2）
        │ ② spawn Toast (node-notifier, wait:true) / Sound
        ▼
   ┌────────────────────────┴────────────────────────┐
   │  Notification layer (Toast / Sound)              │
   │   src/notification/win32.ts                      │
   │   ├─ Toast "View"    → powershell CenterWindow.ps1  (via -CenterPath)
   │   └─ Toast "Dismiss" → node mark-all-read             │
   └────────────────────────┬────────────────────────┘
                            ▼
               [Shared State = state.json]
               src/state/AttentionState.ts
               { events[], unreadCount, visible }
                            │  daemon 轮询 / 写入
                            ▼
               [Daemon = src/daemon.ts]
               pushStateToTrayFile → tray-state.json
                            │
          ┌─────────────────┴──────────────────┐
          ▼                                      ▼
 [Tray = TrayIcon.ps1]                  [Center = CenterWindow.ps1]
 轮询 tray-state.json (500ms)            ★ 直读 state.json + agents.json（只读 View，见 §6.2）
 SetForegroundWindow (double-click)      读 AGENT_ATTENTION_CLI/NODE 回退
          │                                      │
          ▼                                      ▼
 [Target Jump = src/jump.ts]            [Agent Registry = agents.json]
  jumpToTarget(target)  ★死代码           agent.target { type:'terminal', pid }
          │                                      │
          ▼                                      ▼
 [Terminal / target window]             [Agent]
```

**★ 暴露的问题（按 §6 分类）：**

- **F1（高价值，验收 blocker）**：`jumpToTarget` 在 `src/` 零生产调用（Grep 证实，仅 `tests/jump.test.ts` + `docs/` 引用）。Data Flow 末端断裂 → 整条 `Attention→click→jump` 只是测试与文档里的想象。这是 **Architecture-to-Implementation Divergence**，比普通 bug 更值得抓（详见 §6.1）。
- **F2（Release-blocking）**：win32.ts:31 `..','src','center','CenterWindow.ps1'`、daemon.ts:236 `..','src','center','TrayIcon.ps1'`。Bash 证实 `dist/src DOES NOT EXIST` → Toast "View" 点击在发布版找不到脚本（详见 §6.1）。
- **F5 / F6（非 bug，见 §6.2）**：Center 直读 State + Registry、Registry 与 State 分属两个 bounded context，在"只读 + 无一致性契约"下不构成缺陷。

---

## 2. Control Flow（谁控制谁）

```
[daemon-cli start]
   │  killTrayByPid + killOrphanTrayProcesses        (daemon-cli.ts:103-137)
   │  kill 旧 daemon
   │  write daemon.pid
   ▼
[spawn daemon (detached)]  →  src/daemon.ts
   │  ★ 系统级无 daemon Mutex（仅 tray/center 有）
   │  spawnTray (:116-154) 传 -StatePath -CliPath -TrayStatePath -TrayPidPath
   │  checkTrayAlive (:105-114) 死则 respawn
   ▼
[TrayIcon.ps1]  Mutex Local\agent-attention-tray-<user>  (:23)
   │  轮询 tray-state.json
   │  Test-TrayShouldExit (:339-357): stopSignal | tray-state.json 删除 | daemon.pid 失联
   ▼
[退出]  → stop() 删 trayStatePath 再等 5s (:188-223)
          / trap 清 tray.pid+trayStatePath 后 exit(1) (:254-262)

Restart 路径：
   daemon crash → uncaughtException → process.exit(1)
   （无人 restart daemon；daemon-cli start 是一次性入口，无 watchdog）
```

**应当成立、但当前未声明/未强制的 invariant：**
- `daemon_instances = 1`
- `tray_instances = 1`

**暴露的问题：**

1. **"11 个 Tray" 的真实根因（关联 F3）**：Tray 单实例靠 Mutex；但若前一次 Tray 崩在 Mutex Release 之前（trap 仅 `ReleaseMutex`，而 `NullReferenceException` 在菜单 click 时抛出、被 catch 吞、未触 trap）→ Mutex 不释放 → 新 Tray 起不来或旧 Tray 僵尸残留。Control Flow 没有"确保旧 Tray 已死再起新 Tray"的硬同步。
2. **daemon 无 watchdog**：daemon crash 后无人 restart（Control Flow 图里的 `RESTARTING` 节点不存在）。这是 **恢复策略** 问题，不是状态机必须内建 `RESTARTING` 的理由（见 §3 / §6.1 daemon 状态机校正）。
3. **孤儿 Tray 检测脆弱**：`killOrphanTrayProcesses` 用 `get-ciminstance` 查父进程是否 daemon（daemon-cli.ts:103-137）。CIM 在受限/Server Core 环境可能不可用 → 孤儿 Tray 检测假阴性。
4. **daemon 无进程级 Mutex**：两个 `daemon-cli start` 并发可起两个 daemon（各自 spawn 一个 Tray）；tray Mutex 只能挡 Tray 不能挡 daemon → 仍可能 2 daemon 竞态。

---

## 3. State Flow（系统有哪些状态）

```
Attention:  NEW ──recordEvent──▶ ACCEPTED ──(unreadCount>0)──▶ UNREAD
             ▲                      │                            │
             │                   markRead                    clearUnread
             │                      ▼                            ▼
             └────────────────── READ ◀───────────────────── READ(all)
            (AttentionState.ts:122/137/170 各自写 visible)

Agent:  UNREGISTERED ──autoDetectAndRegister──▶ REGISTERED
        (仅保留 last_seen_at；不建 ACTIVE/STALE/DEAD lifecycle —— 见 §6.2)

Daemon: STOPPED ──start──▶ STARTING ──spawn OK──▶ RUNNING
            ▲                                      │
            │                                   (uncaughtException)
            │                                      ▼
            └── stop()/exit ◀── CRASHED ──────────┘
                 │  状态机只记录真实状态；恢复由 Supervisor 决定（见 §6.1）
                 └─ 当前实现: CRASHED → process.exit(1) → STOPPED

Center: HIDDEN ──Open/Show──▶ VISIBLE ──Close/Hide──▶ HIDDEN
        (Mutex Local\agent-attention-center-<user>, CenterWindow.ps1:18)

Tray:   NOT_CREATED ──spawn──▶ CREATED ──(轮询正常)──▶ RESPONSIVE
            ▲                                      │
            │                                   (轮询失败/状态文件删除)
            │                                      ▼
            └────────────────────────────── STALE (可选检测，非必须)
```

**暴露的问题（校正后）：**

1. **Daemon `CRASHED→STOPPED` 是"状态事实"而非"缺陷"**：状态机画了 `CRASHED`，代码 `uncaughtException → process.exit(1)`（daemon.ts:254-262）落 `STOPPED`。这**没有问题**——状态机只应记录真实状态，恢复职责属于 Supervisor，不该让状态机替恢复器背锅。正确建模是：
   ```
   Daemon (state, 记真实):  RUNNING → crash → STOPPED
   Supervisor (policy, 决定): STOPPED → (有 supervisor?) → STARTING → RUNNING
   ```
   若当前 daemon **没有** supervisor，则 `CRASHED→STOPPED` 是可接受的事实记录。不要为了"架构漂亮"在状态枚举里硬塞 `RESTARTING`。
2. **Agent `STALE` 不应实现（已移出必须项）**：产品不是 Agent Manager；v0.3 只需"谁注册过 / 谁最近发过 Attention"。保留 `last_seen_at` 字段即可，不必建 Agent lifecycle state machine，否则开始膨胀（详见 §6.2）。
3. **`visible` 字段被三处独立写**：`recordEvent`/`clearUnread`/`markRead` 各算各的 `visible`（:122/137/170）。单进程串行写，但仍是写分散风险，可作为 State 节点的验证项（见 §7）。

---

## 4. Boundary（每个组件到底负责什么）

| 组件 | 应当负责 | 越界判定（写） | 当前实测 |
|---|---|---|---|
| CLI (`index.ts`) | 采集事件 → 写 State → 发通知 | 禁止改 Registry/daemon 内部 | 直写 `state.json`（经 recordEvent，合理） |
| Daemon (`daemon.ts`) | 单实例、生命周期、把 State 推给 Tray、Tray 健康 | 禁止改 Attention 语义 | 缺 daemon 自身 Mutex、缺 watchdog（恢复策略问题，非越界） |
| Tray (`TrayIcon.ps1`) | 托盘图标、菜单、双击聚焦、退出判定 | **禁止写 Registry / 改 Attention 事实** | 菜单/点击事件 scriptblock 内误用 `$using:`（:135-138/167/207）→ 静默失败（**真 bug，F3**） |
| Center (`CenterWindow.ps1`) | 展示未读列表、单条已读、全部已读 | **禁止直写 State/Registry** | **只读** State + Registry（:43-52/:54-63）→ **不越界，非 bug**（§6.2 F5） |
| Registry (`registry.ts`) | Agent 注册、target 存储 | 禁止存 Attention 事件 | 与 Attention State 分属不同 bounded context（§6.2 F6） |
| State (`AttentionState.ts`) | 未读/事件的唯一真相 | 禁止被 UI 直写绕过命令 | 被 CLI、Daemon 写入，Center 只读 → 写者受控 |

**正确的 invariant（取代"Center 不得读 State"）**：
> `Center MUST NOT mutate State directly except through a defined command/API.`
> 当前 Center 只读 → 合规。**不要**据此引入 IPC 层，除非已明确冻结"所有 UI 必须经 daemon API 获取数据"。

---

## 5. Oracle Flow（每一个结果怎么证明）

**Target Jump（应当这样证，但代码做不到）**
```
Action:      DoubleClick tray → SetForegroundWindow(hwnd)
Observation: 调用返回（无异常）
Oracle:      GetForegroundWindow() == hwnd
Evidence:    GetWindowThreadProcessId(hwnd) → foreground_pid == target_pid
```
★ 实情：`jumpToTarget` 在 `src/` 零生产调用（死代码，F1）→ `SetForegroundWindow` 从未被触发 → `foreground_pid == target_pid` 这个 Oracle 永远没机会跑。整条验证链是**伪证**：代码里画了"点击→聚焦"，运行时根本不接这条线。这是架构承诺与实现背离的直接证据（F1）。

**Mark All Read（应当这样证）**
```
Action:      Center "Mark all read" → node mark-all-read / markAllRead
Observation: 命令返回 0
Oracle:      state.json 中 unreadCount == 0 且 所有 events.read == true
Evidence:    readState(STATE_PATH).unreadCount === 0 && events.every(e => e.read)
```
★ 实情：`markAllRead`/`markEvent` 直调 `clearUnread`/`markRead`（越过 daemon，daemon-cli.ts）。但 Center 走的是 `Start-Process $env:AGENT_ATTENTION_NODE`（CenterWindow.ps1:518-540）——**若 `AGENT_ATTENTION_NODE` 未设，展开为空串 `Start-Process  -ArgumentList...` 静默失败**。Oracle 步骤（readState 复验）在静默失败下根本不会发生 → "全部已读"是伪证。

**Tray 菜单点击（Oracle 实测证伪，F3）**
```
Action:      Click "Open Center" 菜单项
Observation: 无异常抛出（catch 吞掉）
Oracle:      CenterWindow.ps1 进程已启动
Evidence:    Get-Process CenterWindow 存在
```
★ 实情：PowerShell 实测，本地 `.GetNewClosure()` scriptblock 内 `$using:StatePath` 抛 `NullReferenceException: 未将对象引用设置到对象的实例`（与 TrayIcon.ps1:135-138 同构）。菜单点击 / Open Center / 事件项点击全部在 Oracle 步骤前就死了，但 catch 把异常吞了 → Evidence 缺失，用户只看到"点了没反应"。**这是目前最明确的真实 bug。**

**Center 时间戳（Oracle 实测证伪，F4）**
```
Action:      Center 渲染 24h+ 事件
Observation: 显示 "[d ago]"
Oracle:      显示 "2d ago"
Evidence:    PowerShell 实测 "${[math]::Floor($hours/24)}d ago" → "[d ago]"（数字缺失）
```
★ 实情：CenterWindow.ps1:65-75 的 24h+ 分支子表达式方法调用不被插值 → 旧事件时间戳损坏。标准 UI 数据 bug，单元测试本应发现（见 §7 时间边界 oracle）。

---

## 6. 发现二分类（核心校正）★

> 目标：把"合理架构选择"与"真 bug"分开，**避免 Agent 根据地图过度重构**。

### 6.1 真实高价值缺陷（优先修）

| ID | 维度 | 问题 | 证据 | 严重度 / 定位 | 处理路径 |
|---|---|---|---|---|---|
| **F3** | Oracle / Boundary | TrayIcon.ps1:135-138/167/207 本地 `$using:` → `NullReferenceException`，菜单/点击静默失败 | PowerShell 实测复现 | **P0（真实交互路径已被证伪）**；优先级高于 Tray 图标外观 | Reproducer → Regression test → Fix → Reproducer PASS |
| **F2** | Data | 发布版 `dist/src` 缺失，win32.ts:31 / daemon.ts:236 回退悬空 | Bash `dist/src DOES NOT EXIST` | **Release-blocking**（若验收含 `npm publish` / `npm install -g`）；纯开发态则非普通 bug | source → `npm pack` → 安装 tarball → 全新 temp home → daemon/notify/center 冒烟 |
| **F4** | Oracle / Data | CenterWindow.ps1:65-75 `Get-TimeAgo` 24h+ 渲染 `[d ago]` | PowerShell 实测复现 | **P1（标准 UI 数据 bug，单测本应发现）** | 修 bug + 增加时间显示边界 oracle（见 §7） |
| **F1** | Data / Oracle | `jumpToTarget` 死代码，Attention→click→jump 仅存在于测试/文档 | Grep `src/` 零生产引用 | **P1 / 验收 blocker**（v0.3 若承诺"点击通知回对应 Agent"） | Architecture-to-Implementation Divergence：要么接上真实调用，要么撤回承诺 |

**附带校正（非新 bug，但需明确）：**
- **Daemon `CRASHED→STOPPED`**：保留为"状态事实"发现，但**不要求**状态机内建 `RESTARTING`。状态机只记真实状态；恢复由 Supervisor（若有）决定。当前无 supervisor → `CRASHED→STOPPED` 可接受。

### 6.2 架构决策 / 非 Bug（不要据此重构）

| ID | 原判定 | 校正后定位 | 理由 |
|---|---|---|---|
| **F5** | P2 boundary violation（Center 直读 State + Registry） | **非 bug / Architecture Decision Required** | 可定义 `State=持久化事实源`、`Registry=持久化身份源`、`Center=只读 View`。Center 只读不违规。真正 invariant 是"Center MUST NOT mutate State directly except through defined command/API"——当前 Center 只读 → 合规。除非冻结"所有 UI 必须经 daemon API"，否则不必为架构漂亮引入 IPC。 |
| **F6** | P2 boundary（双事实源） | **非 bug / 缺一致性契约** | Registry（who：agent_id/name/version/target/last_seen）与 Attention State（what：event/message/read/timestamp/priority）是**两个不同 bounded context**，不是双写同一事实。需要的是一致性契约：`AttentionEvent.agent_id` 必须能关联 `Registry.agent_id`；Registry 删 Agent ≠ 历史 Attention 自动删。写清规则即可。 |
| **F10-Agent STALE** | P3 | **删除（暂不实现）** | 产品不是 Agent Manager；v0.3 只需"谁注册过 / 谁最近发过 Attention"。保留 `last_seen_at`，不建 Agent lifecycle state machine，避免膨胀。 |

### 6.3 明确移除 / 降级

- Agent `STALE` / `DEAD` lifecycle 状态 → **移出必须项**（过度基础设施化）。
- Tray `STALE` 显式检测 → 可选，非必须。
- F5/F6 的"越界 / 架构错误"措辞 → 替换为"合理的只读视图 / 需补一致性契约"。

---

## 7. Verification Map（系统地图 → 问题发现系统）★

> 这张表是地图的落点：每个节点直接推导 `Component / Invariant / Reproducer / Oracle`。Agent 不需要重新理解整个项目，照表执行验证即可。

| Node | Invariant | Reproducer | Oracle | 当前状态 |
|---|---|---|---|---|
| CLI | 不启动意外程序 | daemon restart | 新 Code.exe PID diff == 0 | FAIL / 待修 |
| State | 原子写 | 150 并发 reader/writer | 0 corrupted reads（JSON parse 全成功） | PASS（随机 tmp + renameSync） |
| Registry | register 幂等 | register ×3 | agents count 不变 | PASS（autoDetect 已修） |
| Tray | 仅 1 实例 | start daemon ×5 | exactly 1 NotifyIcon owner | FAIL（Mutex 释放竞态，见 F3 根因） |
| Tray Click | 点击无异常 | enumerate buttons + BM_CLICK | no exception + expected transition | FAIL（F3 `$using:` NullReferenceException） |
> 注（2026-08-22 措辞校正）：`SendMessage(BM_CLICK)` + `EnumChildWindows` 不是"唯一可靠组合"，而是**当前已验证可用**的程序化交互适配器——前提是目标为 .NET Framework WinForms Center 且 UIA 不提供可用 InvokePattern。控件技术或 WinForms 版本变化时该结论需重新验证，不得作为长期架构承诺。
| Center | Mark all read 生效 | BM_CLICK | unread 2→0 | PASS（直调 clearUnread，绕过 env 依赖时） |
| Target | 回到目标终端 | real terminal + real jump | GetForegroundWindow foreground_pid == target_pid | NOT CONNECTED（F1 死代码） |
| Package | 发布后可运行 | `npm pack` → 安装 tarball → 全新 home → smoke | daemon/notify/center 启动成功 | NOT VERIFIED（F2 风险） |

**派生验证项（从 §6 直接推出）：**

| Node | Invariant | Reproducer | Oracle | 当前状态 |
|---|---|---|---|---|
| Daemon | 仅 1 实例 | start ×N | process count == 1 | FAIL（无 daemon Mutex） |
| Center Time Display | 边界值渲染正确 | unit test 覆盖 0s/59s/60s/59m/60m/23h59m/24h/48h/7d | rendered string 匹配预期 | FAIL（F4 24h+ → `[d ago]`） |

**时间显示边界 oracle（建议固化为自动测试，F4）：**
```
0 sec      → "just now"
59 sec     → "59s ago"
60 sec     → "1m ago"
59 min     → "59m ago"
60 min     → "1h ago"
23h59m     → "23h ago"
24h        → "1d ago"   ★ 当前坏成 "[d ago]"
48h        → "2d ago"
7d         → "7d ago"
```
这些值以后可完全自动验证，纳入单测矩阵即可阻止 F4 类回归。

---

## 已修正（相对前几轮 stale 结论）

- 旧结论"daemon 永不写 visible" → **当前 `recordEvent`/`clearUnread`/`markRead` 均写 `visible`**（隐藏图标现由 daemon 下发驱动）。
- 旧结论"tray-state.json 路径不一致" → **daemon.ts:117 已传 `-TrayStatePath`，已修复**。
- 旧结论"Tray 早期信号处理死代码" → **trap 已改 `Invoke-Exit -Graceful`**（TrayIcon.ps1:33-39）。
- 旧结论"jump process.execPath bug" → **jump.ts 已改 `spawnSync('powershell')`**。
- 旧结论"dedup 分隔符碰撞" → **已改 `JSON.stringify([agent,event,message])` SHA1**（dedup/index.ts:13-15）。
- 旧结论"Center 不 Dispose 共享 SystemIcons" → **已加判 `$oldIcon -ne [System.Drawing.SystemIcons]::Application`**（TrayIcon.ps1:100）。

## 本轮校正摘要（2026-08-21 第二轮）

- **F3（Tray `$using:` NullReferenceException）= 当前最明确真实 bug**，优先级高于图标外观；路径：Reproducer → Regression test → Fix → Reproducer PASS。
- **F2（dist/src 悬空）= Release-blocking 缺陷**，取决于验收是否含 `npm publish`/`npm install -g`；验证须走 `npm pack` → 安装 tarball → 全新 home 冒烟。
- **F4（Get-TimeAgo 24h+）= 标准 UI 数据 bug**，单测本应发现；补时间边界 oracle（0s..7d）后可自动回归。
- **F1（jumpToTarget 死代码）= 高价值 Architecture-to-Implementation Divergence**，v0.3 若承诺"点击回 Agent"则是验收 blocker，要么接上要么撤回承诺。
- **F5（Center 直读 State/Registry）= 非 bug**：State/Registry 为持久化事实/身份源，Center 只读 View 合规；invariant 应为"禁止直写"而非"禁止读"。
- **F6（双事实源）= 非 bug**：Registry(who) 与 Attention State(what) 是不同 bounded context；需补 Identity↔Attention 一致性契约，而非判定架构错误。
- **Agent STALE lifecycle = 删除**，避免 Agent Manager 式膨胀；保留 `last_seen_at`。
- **Daemon `CRASHED→STOPPED` = 状态事实，非缺陷**；恢复职责归 Supervisor，不在状态机内建 `RESTARTING`。
- 新增 **Verification Map**：每个节点推导 `Invariant/Reproducer/Oracle`，Agent 照表验证，无需重读全项目。
