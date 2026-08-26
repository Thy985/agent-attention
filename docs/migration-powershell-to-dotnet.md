# UI Host Behavioral-Preserving Migration：PowerShell → C#/.NET

> 状态：实现前评审稿（v2，已吸纳架构评审）
> 关联：`README` / `PRD v0.3` / `SYSTEM_MAP.md §6.2` / `CLAUDE.md` / `BUG_FINDINGS.md` / `TECH-DEBT.md` / `behavior-contract.md`
> 一句话：**这次迁移是「UI Host 行为对等迁移」，不是「PowerShell → C# 重写」。** 只换实现载体（PowerShell GUI → C# 单 Host 进程），并**分三步**引入通信模型变化（文件轮询 → TCP 通知 → TCP 数据面 → TCP 控制面），每步只引入一种变量。

---

## 1. 核心原则（本次修订的重点）

### 1.1 两次架构变化必须解耦
| 变化 | 本质 | 风险 |
|---|---|---|
| **A. PowerShell → C#/.NET** | 实现载体迁移（UI Host 换了） | 引入 C# 构建/进程/生命周期变量 |
| **B. 文件轮询 → TCP IPC** | 通信模型迁移（通知通道换了） | 引入 TCP/重连/帧协议变量 |
> **注**：原设计为 Named Pipe，实际实现采用 TCP localhost（详见 docs/tcp-vs-named-pipe-decision.md）。

> **若 A、B 绑在一起做**，一旦迁移后行为异常，你无法判断是 UI Host、IPC、生命周期还是 State 传播出的问题。**路线改为 M0–M8，每步只引入一种变量**（见 §8）。

### 1.2 验收语言必须精确（替换旧版"90% bug 消失"）
- ❌ 旧表述："P0/P1/P2 中约 90% 高价值 bug 集中在 PowerShell UI 层；换成 C# 后大半根本不会发生。"
- ✅ 新表述：**"C# 迁移预计消除一类已识别的 PowerShell-host 特有缺陷（作用域/`GetNewClosure`/插值/`Start-Sleep`/无确定 Dispose）；但它不证明系统级可靠性。"** 多进程、State 竞态、单实例、CLI launcher、安装路径、TCP 重连等系统性问题仍需各自验证。

### 1.3 最重要的冻结项是「行为契约」，不是 `state.json`
文件契约只是行为契约的一部分。详见 `behavior-contract.md`（M0 交付物）。C# 只实现语义，不重新定义。

---

## 2. 架构冻结声明（迁移后保持不变）

经 SYSTEM_MAP §6.2 校正为"非 bug"，**一律冻结**：
1. **文件即真相（File-as-Truth）**：`state.json` / `agents.json` / `dedup.json` / `tray-state.json` 是共享事实源。
2. **CLI 独立入口**：`agent-notify` 短命，写文件 + 弹 Toast，**不感知** daemon/管道是否存在（PRD v0.3 硬约束：无 daemon 时 CLI 仍可用）。
3. **State 与 Registry 分属不同 bounded context**：读写权限分离。
4. **单实例 / 生命周期锁**：单 Host 继续持有 Tray Mutex 与 Center Mutex，daemon `O_EXCL` 文件锁——**保留**，且不被管道实例限制替代（见 §9.6）。Toast 激活使用独立 named event，不替代生命周期锁。

> **被修正的项（旧版误述）**：daemon 不是"仅作 UI 进程"。见 §3 角色重定义。

---

## 3. 角色重定义（修正旧版 daemon 描述）

旧版写"daemon 仅作 UI 进程，非真相源"——迁移后 daemon 会起 Pipe server、接受命令、返回 ack，这定义已不准。准确划分：

```
State/Registry  = truth          （文件，唯一真相源）
Node/TS         = core           （agent-notify + daemon 业务逻辑）
daemon         = local UI coordinator / control-plane endpoint
                                （observation + coordination + IPC；可读写 State，可接受 UI 命令）
C# Host        = desktop UI host （WinForms Tray + WPF Center，单进程）
TCP            = realtime / control channel （通知 + 命令回执，localhost 绑定）
```

> 这样 Agent 后续不会再纠结"daemon 到底能不能处理命令"——**能**。daemon 是协调/控制面端点，State 仍是真相。UI 的"核心状态变更"请求经 daemon（或 CLI）落盘，UI 自己只做展示与 Windows 交互。

---

## 4. 目标技术栈

| 层 | 选型 | 版本 |
|---|---|---|
| 通知核心 / 编排 | Node + TypeScript（不变） | 22.22.2 / tsc 5.9.3 |
| **UI Host（单进程）** | **C# WinForms 托盘 + C# WPF Center，合一个 `AgentAttention.UI.exe`** | .NET 10 (`net10.0-windows`) |
| 实时通信 | **Windows Named Pipe**（分阶段接入，M5 起） | `NamedPipeServerStream` / `NamedPipeClientStream` / `NamedPipeServerStreamAcl`（.NET 10 原生） |
| 本地工具链 | mise 接管 .NET 10 SDK | `mise.toml` pin `dotnet = "10.0.400"` |

> 已实测（2026-08-22/23）：`mise where dotnet` → `installs\dotnet\10.0.400`；`dotnet new wpf` + `winforms` + `build -c Release` → 0 警告 0 错误；`Microsoft.WindowsDesktop.App 10.0.11` 在场。

---

## 5. 行为契约冻结（M0）

完整契约见 **`behavior-contract.md`**，迁移各阶段以此为回归红线。摘要：

- **CLI Contract**：`mark-all-read` / `mark-event <id>` / `jump <agent-id>` / `agent register|list|target set|clear` / `daemon start|stop|restart|status` / `doctor`（退出码 0/1）。
- **State Contract**：`state.json`（unreadCount + events[]），schema 零改，C# 只读。
- **Registry Contract**：`agents.json`（agents[] + target），schema 零改。
- **Tray Contract**：Mutex `Local\agent-attention-tray-<user>`；单/双击去抖；双击→`mark-all-read`；事件项→`mark-event`；菜单→拉 Center。
- **Center Contract**：Mutex `Local\agent-attention-center-<user>`；渲染≤8 条；轮询 2000ms；全部已读 / 逐条已读 / 点击 agent→`jump`。
- **Command Contract**：mark-read / mark-all-read / jump 在 M1–M6a 经既有 Node CLI；M6b 才可迁 TCP RPC。UI 不得直写 State。`open-center` 不走 daemon 命令或 TCP：Tray 进程内调用，Toast 走单实例 activation handshake。
- **Target Contract**：`jump` 经 Win32 聚焦注册终端目标，best-effort，不改状态。

> **铁律**：C# 只实现上述语义，不为"C# 便利"改语义。任何语义改动先回 `behavior-contract.md` 评审。

---

## 6. 兼容边界（冻结清单）

迁移期必须保持二进制兼容的契约：
1. `state.json` / `agents.json` schema **零改动**。
2. `tray-state.json`：daemon 仍写（带 light hash），作 UI 降级源；写入必须改为临时文件 + rename。C# 优先读 Pipe、断线回退此文件。
3. spawn 参数名 `-StatePath`/`-RegistryPath`/`-CliPath`/`-TrayStatePath`/`-TrayPidPath` **沿用**，仅把可执行从 `.ps1` 换 `.exe`。C# 新增 `-OpenCenter` 只用于 Toast 激活。
4. Tray/Center Mutex 名不变。单 Host 按 Tray → Center 顺序获取；第二个 UI 实例通过 named event 激活已有 Host 后退出 `0`。
5. `O_EXCL` daemon 单实例锁不变；`tray.pid` 兼容期继续保存 UI Host PID。
6. `AGENT_ATTENTION_UI` 灰度开关（`csharp`|`ps`）覆盖 daemon spawn、Toast View、Dismiss 后的 Center 激活和安装脚本，验证稳定后删除（见 §11.3）。

---

## 7. 进程拓扑（最终形态）

```
                    Agent / Skill
                         │
                    agent-notify
                         │
                         ▼
                   Node/TS Core
                         │
            ┌────────────┼────────────┐
            │            │            │
        state.json   agents.json   dedup.json
            │
            │
         daemon  (coordinator / control-plane)
            │
            ├──────── writes ────────→ tray-state.json   (durable fallback)
            │
            └──── TCP localhost ──────→ AgentAttention.UI.exe   (realtime / control)
                                             │
                                ┌────────────┴────────────┐
                                │                         │
                           WinForms Tray              WPF Center
                                │                         │
                                └────────────┬────────────┘
                                             │
                                         Windows API
```

```
State/Registry = truth
Node          = core
daemon        = coordinator
TCP           = realtime / control channel（localhost，端口通过 ipc-port.txt 握手）
C# Host       = desktop UI host（单进程，Tray+Center 同源）
```

---

## 8. 迁移路线图（M0–M8，每步单一变量）

| 阶段 | 引入的变量 | 内容 | 退出标准 | 回滚 |
|---|---|---|---|---|
| **M0 Contract Freeze** | — | 锁 `behavior-contract.md` + 本文件；建 `mise.toml` | 契约文档评审通过 | — |
| **M1 C# Host + 文件模型等价** | C# 单 Host 进程 | 建 `AgentAttention.UI.exe`（WinForms Tray + WPF Center 同源）；只读 `state.json`/`agents.json`/`tray-state.json`，无任何 Pipe；实现 `-OpenCenter` 与 named-event 握手；命令适配器继续调用 Node CLI；`AGENT_ATTENTION_UI=csharp` 可启 | `dotnet build` 0 错 0 警；进程启动、托盘出现、Center 能读文件渲染；重复激活只有一个托盘 | 切回 `.ps1` |
| **M2 Tray parity** | Tray 行为 | C# Tray 等价实现 Mutex/去抖/双击已读/事件项已读/菜单拉 Center；全部状态命令经 CLI 适配器 | L3：点击不卡死（P0-2 消亡）、双击 `unreadCount==0`、去抖等价 | 切回 `TrayIcon.ps1` |
| **M3 Center parity** | Center 行为 | C# Center 等价实现≤8 条/2000ms 轮询/全部已读/逐条已读/点击 agent→CLI `jump` | L3：渲染、已读 `unreadCount==0`、跳转 `GetForegroundWindow()==hwnd` | 切回 `CenterWindow.ps1` |
| **M4 全链路回归** | — | 行为对等门全过；对比 ps1 与 csharp 实机行为一致；Toast View 按 `AGENT_ATTENTION_UI` 选择正确 Host | 对等矩阵 100% 通过 | — |
| **M5 TCP 影子通知** | TCP 通知通道 | daemon 起 TCP server **仅发通知**：`state-changed` / `registry-changed` / `daemon-status`；UI 收到后仍从文件读取 snapshot，并保留原轮询作为对照 | L3：通知 ≤50ms 可观测；TCP on/off 渲染结果一致；UI 不崩 | daemon 关 TCP，UI 回退纯轮询 |
| **M6a TCP 接管刷新** | 实时数据面 | TCP 成为刷新 fast path；断线降级轮询文件；重连后丢弃通知并从 State 文件重建 full snapshot | L3：零轮询延迟、daemon 重启自动重连、杀 TCP 后 UI 继续可用 | 关闭 fast path，回退文件轮询 |
| **M6b TCP 命令 RPC** | 双向控制面 | 仅迁移 `cmd-mark-read`/`cmd-mark-all-read`/`cmd-jump`，带 ack/error；失败自动回退 CLI；CLI 命令面保留为独立入口 | L3：命令有回执；RPC 失败时 CLI fallback 成功；退出码语义可对照 | 关闭 TCP 命令，固定走 CLI |
| **M7 默认切换与浸泡** | 默认载体 | `AGENT_ATTENTION_UI` 默认改 `csharp`；保留 `ps` 回滚开关一个版本周期；收集崩溃、句柄、图标、Toast 激活指标 | 一个版本周期内 P0/P1 为零，长跑 GUI 句柄稳定 | 默认切回 `ps` |
| **M8 删除 PowerShell** | 去掉旧载体 | 删两个 `.ps1`、移除灰度开关、更新 package files/scripts、安装器和文档同步 | Jest/L2/L3/L4/L5 全过；文档无 `.ps1` 启动路径 | 从 git 历史恢复（删除前确认 tag/release 可回滚） |

> **关键**：M1–M4 全程**无 Pipe**，但允许既有 CLI 作为命令适配器——这是保持 mark-read/jump 行为所必需的。UI 不直写文件、不复制 jump 实现。M5 只增加影子通知，M6a/M6b 分别切换数据面和控制面，避免一次引入多个变量。

---

## 9. TCP IPC 设计（已实施，替代原 Named Pipe 方案）

> **决策记录见** `docs/tcp-vs-named-pipe-decision.md`。

### 9.1 两个平面
```
DATA PLANE      state.json / agents.json / dedup.json / tray-state.json   （真相，冻结）
CONTROL/EVENT   TCP localhost:35000-45000                                  （实时/控制，可丢）
```
> **TCP 丢消息没有关系，因为 State 可以重新 snapshot。** 这条写进协议头注释。

### 9.2 端口发现机制
- daemon 启动时绑定 35000-45000 范围内的随机端口
- 端口写入 `$HOME/.agent-attention/ipc-port.txt`（原子 tmp+rename）
- UI Host 启动时读取该文件获取当前端口
- daemon 重启后新端口覆盖旧文件，UI 下次启动读取新端口

### 9.3 第一阶段：单向通知通道（M5）
仅 daemon→UI，三类消息：
| type | 方向 | 说明 |
|---|---|---|
| `state-changed` | daemon→UI | 见 §9.6 |
| `registry-changed` | daemon→UI | agents.json 变化通知 |
| `daemon-status` | daemon→UI | daemon 存活/重启信号 |

> **M5 阶段 TCP 是单向 notification channel，不是 RPC。** UI 不回命令。

### 9.4 命令阶段（M6b，数据面稳定后增量）
仅迁移 `cmd-mark-read` / `cmd-mark-all-read` / `cmd-jump`。每条请求带 `requestId` 和 5 秒超时；daemon 返回 `{ ok, code }` 或结构化 error。RPC 失败、超时、断线时自动回退 Node CLI。CLI 命令面继续保留为独立入口和 fallback。`open-center` **不走 TCP**：Tray 在 Host 内调用；Toast 走 §7 activation contract。

### 9.5 帧协议
- 帧格式：4 字节小端 uint32 长度前缀 + UTF-8 JSON；单帧上限 64KB
- **TCP messages are notifications, not durable truth. After reconnect, the UI MUST rebuild a full snapshot by reading State files; it MUST NOT wait for or request TCP history.**
- 连接：server 是 daemon（TcpListener），client 是唯一 UI Host（TcpClient）；同一时间只接受一个 client
- UI 启动立即尝试一次，之后按 250ms 起步、5s 封顶、带 jitter 的指数退避连接
- 重连：成功后丢弃已收消息、按当前文件内容重建 full snapshot

### 9.6 消息简化：只用 `state-changed`
- ❌ 旧版同时定义 `event-pushed` + `unread-changed` → 两消息竞权、UI 不知谁是权威
- ✅ 第一版通知不携带业务 delta，只携带可校验的文件版本：
```json
{ "v": 1, "type": "state-changed", "file": "state", "contentSha256": "<hex>" }
```
`contentSha256` 是原始文件字节的 SHA-256，不是新增 State schema 字段；daemon 可对相同 hash 的通知做合并。UI 收到后直接从 `state.json` 读取全量 snapshot，**不存在"向 TCP 请求 snapshot"的动作**。数据量仅最近 ~20 条，无需 delta 协议。

### 9.7 `tray-state.json` 长期保留为 fallback
```
TCP         = fast path
tray-state.json = durable fallback
state.json    = truth
```
daemon 始终写 `tray-state.json`；写入必须是临时文件 + rename，避免 UI fast path 断开时读到撕裂 JSON。UI TCP 断→文件轮询。迁移有清晰降级路径。

### 9.8 安全边界（TCP vs Named Pipe）

Named Pipe 原设计的优势是 Windows ACL（用户级隔离）。TCP localhost 方案的等价保证来自：
- **绑定范围**：仅 `127.0.0.1`，外部网络不可达
- **端口随机化**：35000-45000 高位区间，降低扫描命中率
- **握手协议**：UI 连接后需发送合法帧才能建立会话

遗留风险：任何本机进程可扫描并连接开放端口。详见 `docs/tcp-vs-named-pipe-decision.md` §"遗留风险"。

## 10. 单 Host 进程设计（结构要点）

> **用户评审最大结构性建议**：不要产出 `tray.exe` + `center.exe` 两个进程，而是**一个 `AgentAttention.UI.exe`**，进程内同时跑 WinForms `NotifyIcon` 与 WPF Center 窗口。

收益：
- 生命周期从 `daemon / tray / center` 三进程降为 `daemon / UI Host` 两进程：
  ```
  1 daemon
  1 UI Host
     ├── WinForms Tray
     └── WPF Center (0..1 窗口)
  ```
- 单实例问题直接减半；"11 个图标"类顽疾根因消除。
- `open-center` 与状态命令边界必须分开：
  ```
  Tray click            → Center.Show/Activate()     （Host 进程内）
  Toast View (C#)       → AgentAttention.UI.exe -OpenCenter → named-event 握手（短命 activator，无 Pipe payload）
  mark-read/all-read    → M1–M6a Node CLI；M6b Pipe RPC + CLI fallback
  jump                  → M1–M6a Node CLI；M6b Pipe RPC + CLI fallback
  State/Registry 写入   → 只属于 CLI/daemon；UI 永不直写
  ```
- WPF Center 用 `Show()` modeless（非模态），可独立开关，不阻塞托盘消息泵。

> 实现注意：不要运行两套竞争消息循环。使用一个 `[STAThread]` UI 主线程和单一 WPF `Dispatcher`；在该线程上创建 WinForms `NotifyIcon`/context menu 和 WPF Center。所有 Windows 句柄、icon、timer、pipe reader 回调都必须 marshal 回 UI 线程。后台只做 I/O 和 JSON 解析。

### 10.1 单实例与生命周期
- 启动顺序：解析路径 → 获取 Tray Mutex → 获取 Center Mutex → 初始化 named activation event → 创建 UI。
- 若 Tray Mutex 已被现有 Host 持有且带 `-OpenCenter`：signal event 后退出 `0`；否则也退出 `0`，不得创建第二个托盘。
- 若 Center Mutex 被旧版 PowerShell Center 占用，Host 做 bounded retry；超时后记录 warning 并退出非零，避免双窗口并存。
- daemon 是 UI Host 的父进程：spawn 后写兼容路径 `tray.pid`，崩溃时按现有 tray respawn 策略重启。手动启动的 Host 遵循同一文件生命周期信号。
- daemon stop 先删除 `tray-state.json`，等待 Host 移除托盘并退出；超过宽限后才允许 terminate。SIGTERM/TerminateProcess 只是兜底，不是正常停止协议。

---

## 11. 分发 / 仓库 / 灰度（三个待决项——已定结论）

### 11.1 分发方式：**首版 self-contained**
- 开发期用 framework-dependent（体积小、迭代快）；**正式分发 v1 用 self-contained**（`dotnet publish -c Release -r win-x64 --self-contained true`）。
- 理由：单用户、Windows-only、小工具——避免把".NET runtime missing / 版本不匹配 / Windows Desktop runtime"引入产品支持面。
- **self-contained 产物不直接塞进默认 npm tarball。** npm 包保留 Node CLI、daemon 和灰度 launcher 解析逻辑；UI Host 以版本化 `win-x64` zip/release artifact 分发，安装器按 repo → `AGENT_ATTENTION_UI_EXE` → package-local optional artifact → release cache 的顺序解析。CI 必须记录 publish 目录大小、压缩包大小、npm tarball 增量和冷启动时间；若未来选择内嵌模式，压缩包增量超过 100MB 必须重新评审。
- 微软文档确认 self-contained 不要求客户端额外安装对应运行时。

### 11.2 本仓还是独立 repo：**本仓**
- 同一产品、同一版本、同一验证契约。C# 工程放 `src/center/csharp/`（单 Host 方案下即 `src/center/csharp/AgentAttention.UI/`）。不拆 repo。

### 11.3 灰度开关：**保留一个版本周期，然后删除**
- `AGENT_ATTENTION_UI=csharp|ps` 用于 M1–M7 回滚，并覆盖 daemon spawn、Toast View、Dismiss 后的 Center 激活和安装脚本。
- 当 C# UI 通过 L3/L4/L5 全链路稳定且 M7 浸泡期达标 → 删 PowerShell 与开关（M8）。

---

## 12. 验证 Oracle 映射（L3 实机，非单测）

| 断言 | Oracle（可观测） |
|---|---|
| 托盘常驻不卡死 | 点击后进程存活、无模态死锁 |
| 双击全部已读 | `unreadCount==0`（读 state.json） |
| 逐条已读 | 该 event `read==true` |
| 渲染上限 8 | 第 9+ 条不渲染 |
| 跳转聚焦 | `GetForegroundWindow()==target hwnd` |
| 单实例/激活 | 带 `-OpenCenter` 的第二实例 signal event 后 `exit 0`；已有 Host 显示 Center；无第二个托盘 |
| Toast View 载体切换 | `AGENT_ATTENTION_UI=csharp|ps` 时分别解析到 `.exe`/`.ps1`；另一载体不存在时给出可诊断错误 |
| 生命周期停止 | daemon stop 先删 fallback 文件；Host 移除托盘后退出；宽限期后无 ghost icon |
| fallback 文件完整性 | 并发写读循环中 JSON parse 成功率 100%；`tray-state.json` 使用 tmp + rename |
| 实时推送（M5+） | daemon 写 state 后 UI ≤50ms 刷新 |
| 影子通知一致性（M5） | Pipe on/off 后 Center/Tray 渲染 hash 相同 |
| 数据面接管（M6a） | 杀 Pipe/daemon 重启时文件轮询继续渲染；恢复后 snapshot 与 State 一致 |
| 命令回执与回退（M6b） | `cmd-mark-*` 返回 `ok/error`；`cmd-jump` 返回 `focused/not-found`；RPC 失败自动走 CLI 且状态正确 |
| Pipe ACL | 其他用户进程连管道 `UnauthorizedAccessException` |
| 重连（M6a+） | 杀 daemon 再起，UI 自动重连、按文件重建 snapshot、不崩 |
| 句柄无泄漏 | 长时 `GetGuiResources(hWnd, GR_USEROBJECTS)` 稳定 |
| 分发体积 | CI 输出 publish、zip、tarball 增量；默认 npm tarball 不包含 self-contained runtime |

> 所有 Oracle 必须 Windows 实机（L3）跑；沙箱/单测盖不住真实交互路径（P0/P1 全在实机暴露）。

---

## 13. 工具链（mise 接管）

- `mise.toml`：`dotnet = "10.0.400"`，进项目目录自动激活（真实交互终端实测 `dotnet --version`→10.0.400）。
- 已知坑（本沙箱非交互 bash）：mise 2026.8.5 的 `hook-env`/`exec` 曾 panic，属 mise 自身 bug、与 C# 无关；真实终端无碍，若也崩则 `scoop update mise`。
- 保底：CI/脚本编 C# 用完整路径 `C:\Users\lenovo\AppData\Local\mise\dotnet-root\dotnet.exe`。
- C# 构建清理：删产物前先 `taskkill /IM VBCSCompiler.exe /F`（Roslyn 编译服务器锁 DLL）。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| C# 构建复杂度（旧 `tsc` 不复制资源） | `dotnet publish` 自带资源；CI 增 `dotnet build`；artifact 清单显列 exe/pdb/runtime 文件 |
| Toast View 仍固定 spawn PowerShell | M1 起把 launcher 收敛到统一 resolver，按 `AGENT_ATTENTION_UI` 选择 `.exe`/`.ps1`；L3 断言两个分支 |
| 第二实例与 Mutex 竞争 | Tray Mutex 判定 + named event 握手；Center Mutex bounded retry；L3 覆盖已有 Host、无 Host、旧 PS Center 三态 |
| UI 复制 jump/read 语义造成漂移 | M6b 前 Node CLI 是唯一命令适配器；C# 只解析结果和渲染，不实现 State 写入或独立 jump |
| Pipe 取代轮询后 daemon 崩致 UI 失联 | UI 捕 `IOException`→指数退避重连+降级轮询文件（§9.5/9.7） |
| 单 Host 内 WinForms+WPF 消息泵共存 | 单 `[STAThread]` + WPF Dispatcher；NotifyIcon 在同一线程创建；禁止双消息循环 |
| self-contained 撑爆 npm 包 | 默认只发布 release artifact；CI 输出体积门槛建议和冷启动指标 |
| 终端用户无 .NET 10 运行时 | self-contained publish（§11.1） |
| 重写引入功能回归 | 保留 `.ps1` 对照 + 行为对等矩阵（behavior-contract.md §9）逐项复验 |
| A/B 两变化绑一起难归因 | M0–M8 分阶段；M5/M6a/M6b 分别只切换影子通知、数据面、控制面 |

---

## 15. 下一步

- **M0 已完成**（契约冻结 + `mise.toml`）。
- 建议下一步开工 **M1**：建单 Host C# 工程骨架（WinForms Tray + WPF Center 同一 UI 线程、既有启动参数、`-OpenCenter` activation handshake、CLI 命令适配器、文件读取、无 Pipe）。M1 不把 self-contained runtime 放进默认 npm tarball；先以 framework-dependent/repo artifact 验证 L3。
