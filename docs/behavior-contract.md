# 行为契约冻结文档（Behavior Contract Freeze）

> 状态：冻结基线（M0 交付物，迁移前锁定）
> 关联：`migration-powershell-to-dotnet.md` §5 / §8（M0）
> 目的：本次迁移是 **UI Host Behavioral-Preserving Migration**（行为对等迁移），不是 C# 重写。C# 层**只实现**下列契约语义，**不得重新定义**任何语义。本文是迁移各阶段的回归红线。

---

## 0. 契约来源与权威定义

| 契约 | 权威实现（冻结前真实代码） | 抽取方式 |
|---|---|---|
| CLI Contract | `src/daemon-cli.ts` | 命令分发 `main()` |
| State Contract | `src/state/AttentionState.ts` | 文件 schema |
| Registry Contract | `src/registry.ts` | 文件 schema |
| Tray Contract | `src/center/TrayIcon.ps1` | 行为/参数 |
| Center Contract | `src/center/CenterWindow.ps1` | 行为/参数 |
| Command Contract | `src/daemon-cli.ts` + 两个 `.ps1` 的 `Start-Process` 调用 | UI 发起的命令集 |
| Target Contract | `src/jump.ts` + `daemon-cli.ts:jumpToAgent` | 跳转语义 |

> **规则**：若本文某字段与权威实现不一致，以权威实现为准；任何"为 C# 便利"的语义改动都必须先回到本文评审、而非默默改掉。

---

## 1. CLI Contract（核心命令面，Node/TS 不变）

- 可执行体：`agent-attention`（Node，编译产物 `dist/daemon-cli.js`）。
- 路径解析：CLI 路径可被 `AGENT_ATTENTION_CLI` 覆盖；Node 运行时可由 `AGENT_ATTENTION_NODE` 覆盖（供 UI 进程派生）。
- 退出码：成功 `0`；用法错误 `1`（如缺参数/实体不存在）。
- **命令集（真实，冻结）**：

| 子命令 | 参数 | 副作用 | 归一化名（本文 Command Contract 用） |
|---|---|---|---|
| `daemon start` | — | 启动 daemon 后台进程 | — |
| `daemon stop` | — | 停止 daemon | — |
| `daemon restart` | — | 重启 daemon | — |
| `daemon status` | — | 打印 DaemonStatus | — |
| `mark-all-read` | — | 写 `state.json`：全部 events `read=true`，`unreadCount=0` | `mark-all-read` |
| `mark-event <id>` | event-id | 写 `state.json`：该 event `read=true`，`unreadCount-=1` | `mark-read <event-id>` |
| `jump <agent-id>` | agent-id | **不改状态**；Win32 聚焦该 agent 的注册终端目标 | `jump <agent-id>` |
| `agent register <id> <name>` | id, name | 写 `agents.json`：新增 agent | `register-agent <id> <name>` |
| `agent list` | — | 读 `agents.json`：列出 | — |
| `agent target set <id> --pid <n>` | id, pid | 写 `agents.json`：设 target | `update-target <id> <pid>` |
| `agent target clear <id>` | id | 写 `agents.json`：target=null | `update-target <id> null` |
| `doctor` | — | 健康自检 | — |

> **注意**：`open-center`（打开消息中心）**不是 daemon 命令**。当前有两个入口：Tray 在同一 UI 进程内直拉 Center；Toast View 由 `win32.ts` 拉起 Center。迁移到单 Host 后，Tray 入口仍是进程内调用；Toast View 改为启动/激活 `AgentAttention.UI.exe -OpenCenter`，通过单实例 activation handshake 交给已有 Host。该路径不使用 Node daemon 命令或 Named Pipe 数据协议。

---

## 2. State Contract（文件即真相，冻结）

- 文件：`~/.agent-attention/state.json`（Attention 事件真相）。
- 权威 schema：`src/state/AttentionState.ts`。迁移中 **schema 零改动**，C# 只读、不新增字段。
- 可观测关键字段（用于 Oracle，非穷举）：
  - `unreadCount: number` — 未读总数。
  - `events: Array` — 事件列表，每项含 `id`、`read: boolean`、`timestamp`、关联 `agentId`、消息体、优先级等。
- 读写方：CLI/daemon **写**；Center **只读**；Tray 读（经 `tray-state.json` 快照）。
- 原子性：CLI 写必须原子（写临时文件 + rename），否则多 CLI 并发会撕裂。

---

## 3. Registry Contract（Agent 身份，冻结）

- 文件：`~/.agent-attention/agents.json`。
- 权威 schema：`src/registry.ts`。迁移中 **schema 零改动**。
- 关键结构：`agents: Array<{ id, name, target?: { pid, ... } }>`。
- 读写方：CLI/daemon **写**；Center **只读**。
- `target` 是 `jump` 的唯一真相来源（Target Contract）。

---

## 4. Tray Contract（托盘行为，冻结语义）

- 进程：迁移后由一个 `AgentAttention.UI.exe` 同时承载 Tray 和 Center。兼容期继续保留 Tray Mutex `Local\agent-attention-tray-<user>` 和 Center Mutex `Local\agent-attention-center-<user>`（`\` → `_` 清洗）；Host 启动时按此顺序获取，第二个实例不得重复创建托盘或窗口。
- 启动参数（当前 `TrayIcon.ps1`）：`-StatePath` `-CliPath` `-TrayPidPath` `-TrayStatePath`；迁移到 `.exe` 后**参数名沿用**。C# 另有只用于激活的 `-OpenCenter` 开关，见 §7。
- 行为（必须被 C# 等价保留）：
  - 常驻系统托盘，**点击不崩溃、不卡死**（P0-2 红线）。
  - 单/双击去抖：`suppressClick` 机制——双击时抑制随后的第二次单击动作（保持现有语义，不得"简化"掉）。
  - **双击 → `mark-all-read`**。
  - 事件项点击 → `mark-event <id>`（经 `AGENT_ATTENTION_NODE` + CliPath 派生）。
  - 菜单"Open Center" → 同一 Host 内显示/激活 Center。
  - 退出时写 `tray.pid` / 响应 daemon 优雅停止（tray-state.json 消失即退出）。
- 数据来源：M1 起读 `tray-state.json`（文件）；M6a 起优先 Pipe、断线降级回文件。

---

## 5. Center Contract（消息中心行为，冻结语义）

- 进程：M1–M4 兼容期保留独立 Center Mutex；最终实现中该 Mutex 由同一个 UI Host 与 Tray Mutex 一起持有，用于阻止旧版独立 Center 与新 Host 并存。
- 启动参数（当前 `CenterWindow.ps1`）：`-StatePath` `-RegistryPath`；迁移到 `.exe` 后**参数名沿用**。
- 行为（必须被 C# 等价保留）：
  - 渲染**最多 8 条**事件（`maxShow = Min(events.Count, 8)`，当前 `CenterWindow.ps1:213`）。
  - 轮询刷新：当前 `refreshIntervalMs = 2000`；M1 文件轮询、M6a 起优先 Pipe。
  - "全部已读"按钮 → `mark-all-read`。
  - 逐条"已读" → `mark-event <id>`。
  - 点击 agent 行 → `jump <agent-id>`（聚焦其终端目标）。
  - 已读后 `unreadCount == 0`（Center 内可见）。
  - 窗口模型：`Show()` modeless（非模态），可独立存在/关闭，不阻塞托盘。
- 数据来源：读 `state.json` + `agents.json`（只读）。

---

## 6. Command Contract（UI 可发起的命令集，归一化）

> 这是 UI 层允许"发起"的全部动作。**语义以 §1 真实命令为准**，此处归一化命名供协议/测试统一引用。

| 归一名 | 真实命令 | 是否改状态 | 幂等 | 首版走 Pipe？ |
|---|---|---|---|---|
| `mark-read <id>` | `mark-event <id>` | 是 | 是（已读再读 no-op） | M6b 之后（命令阶段） |
| `mark-all-read` | `mark-all-read` | 是 | 是 | M6b 之后 |
| `register-agent <id> <name>` | `agent register ...` | 是 | 是 | 不在本次 UI 命令面 |
| `update-target <id> <pid|null>` | `agent target ...` | 是 | 是 | 不在本次 UI 命令面 |
| `jump <agent-id>` | `jump <agent-id>` | **否** | 否（best-effort） | M6b 之后 |
| `open-center` | （进程内直拉，非命令） | 否 | — | **永不走 Pipe**（单 Host 内调用） |

> **关键边界**：UI 在所有阶段都**不得直接写** State/Registry。M1–M6a 的 mark-read、mark-all-read、jump 继续以既有 Node CLI 作为唯一命令适配器；M6b 才允许把这些命令迁到 Pipe RPC，并必须保持 CLI 语义和退出码可对照。`open-center` 不是状态命令：Tray 路径进程内调用；Toast View 只触发单实例激活，不走 daemon/Pipe 协议。

---

## 7. UI Activation Contract（Toast → Center）

- 可执行体：C# 阶段为 `AgentAttention.UI.exe`；PowerShell 回滚阶段仍为 `CenterWindow.ps1`。选择依据是 `AGENT_ATTENTION_UI=csharp|ps`。
- Toast View 参数：
  - C#：`AgentAttention.UI.exe -StatePath <state> -RegistryPath <registry> [-CliPath <cli>] [-TrayStatePath <tray-state>] [-OpenCenter]`
  - PowerShell：沿用现有 `-StatePath` / `-RegistryPath`。
- 单实例握手：
  1. 新进程先探测 Tray Mutex。
  2. 若已有 Host 持有 Mutex，新进程 signal named event `Local\agent-attention-ui-open-center-<user>` 后立即退出 `0`；Host 收到信号后在自身 UI 线程 `Show()/Activate()` Center。
  3. 若没有已有 Host，新进程完成正常 Host 初始化并打开 Center。
- 该契约只解决“激活哪个进程”，不携带业务 payload，也不替代 TCP IPC。禁止用 Toast 参数传递事件内容或状态写命令。
- Node 侧必须根据 `AGENT_ATTENTION_UI` 选择 C# exe 或 PowerShell 脚本；灰度期内不允许 Toast 固定 spawn `.ps1`。

## 8. Target Contract（跳转语义，冻结）

- 触发：CLI `jump <agent-id>` 或 Center 点击 agent 行。
- 真相：`agents.json` 中该 agent 的 `target.pid`。
- 行为：UI 调用 CLI `jump <agent-id>`；`src/jump.ts` 再通过 Win32 API 聚焦该 pid 对应窗口（best-effort，不保证成功）。M6b 前 C# 不得复制一套独立的 jump 实现来绕过权威 CLI。
- **不是状态变更**：jump 不写 `state.json`/`agents.json`。
- Oracle（L3 实机）：`GetForegroundWindow() == target hwnd` 视为聚焦成功；失败仅告警、不抛 fatal。

---

## 9. 行为对等测试矩阵（Behavioral Parity Gate）

每一行是 M2/M3 必须通过的**等价断言**——C# 行为与 `.ps1` 一致即过关，不追求"更好"。

| 行为 | ps1 参考 | C# 要求 | Oracle（L3） |
|---|---|---|---|
| 托盘常驻不卡死 | `TrayIcon.ps1` Click 处理 | 点击后进程存活、无模态死锁 | 点击后 `GetForegroundWindow` 变化 / 进程不退出 |
| 双击全部已读 | TrayIcon 双击 → `mark-all-read` | 双击 → 同命令 | `unreadCount==0` |
| 逐条已读 | Center `mark-event` | 相同 CLI 语义（M1–M6a 经命令适配器） | 该 event `read==true` |
| 渲染上限 8 | `maxShow=Min(Count,8)` | 同上限 | 第 9+ 条不渲染 |
| 跳转聚焦 | Center 点击 agent → `jump` | 相同 CLI 语义 | `GetForegroundWindow()==hwnd` |
| 单实例 | Tray/Center Mutex | Mutex 同名复用 | 第二个实例退出且 `exit 0` |
| open-center 激活 | Tray 直拉；Toast 启动/激活 Host | Tray 进程内 `Show/Activate`；Toast 走 §7 握手 | Center 出现、无新 node 业务进程、重复激活不产生第二个托盘 |
| 去抖 | `suppressClick` | 同语义 | 双击不触发两次单击动作 |

---

## 10. 冻结范围之外的明确声明

以下**不在本次冻结**，可在迁移中调整（但须评审）：
- 内部实现手段（事件循环、定时器、绑定框架）——只要对外行为等价。
- `tray-state.json` 是否长期保留（建议保留为 fallback，见迁移文档 §9）。
- 分发形态（self-contained vs framework-dependent，见迁移文档 §11）。

以下**冻结、不得改**：命令语义、state/agents schema、Mutex 名、spawn 参数名、activation 参数名与握手语义、文件即真相、CLI 独立入口。
