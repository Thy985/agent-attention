# Post-Migration Acceptance

> 状态：待执行（M8 完成后冻结代码，独立验收）
> 关联：`migration-powershell-to-dotnet.md` / `behavior-contract.md`
> 判定基准：**"PowerShell UI → C#/.NET 的实现迁移已完成，Core 行为回归门已建立；当前剩余风险集中在 TCP IPC 的安全/恢复、发布分发，以及真实 Windows UI/UX 验收。"**

---

## 范围说明

143 个单元测试（20 suites）已通过，TypeScript 编译 clean。这证明了：

> **在当前测试定义的行为契约内，C# UI Host 与 Node/TS Core 的交互没有回归。**

但以下真实场景仍需在 Windows 实机上独立验证：

---

## 1. Behavioral Parity（行为对等）

**目标**：确认 C# UI 在所有用户可见操作上与旧 PowerShell UI 行为一致。

| 操作 | 输入 | 预期输出 | 验证方式 |
|---|---|---|---|
| 初始渲染 | `unreadCount=0, events=[]` | Tray icon 无红点，Center 空列表 | 实机截图 + `tray-state.json` hash |
| 新事件到达 | daemon 写 `state.json` | Tray 红点 + 计数更新 | chokidar ≤50ms |
| Mark All Read | 双击 Tray / Toast Dismiss | `unreadCount→0`，事件全部 `read=true` | 读 `state.json` |
| Mark Event Read | 点击 Center 单条事件 | 该 event `read=true` | 读 `state.json` |
| Jump | 点击 Center agent 行 | 终端窗口聚焦（`GetForegroundWindow`） | Win32 API |
| Refresh | Tray 菜单 Refresh | `tray-state.json` 重新同步 | 时间戳对比 |
| Open Center | Toast View / Tray 菜单 | Center 窗口显示且置顶 | `IsVisible` + `TopMost` |
| Hide Center | Center 关闭按钮 | 窗口隐藏，Tray 继续运行 | `IsDisposed` check |
| Daemon stop | `daemon stop` | Tray 图标消失，Host 退出码 0 | 进程扫描 |

---

## 2. Process Lifecycle（生命周期矩阵）

**目标**：证明单进程 Host 模型在异常路径下不产生 zombie 或双实例。

| 场景 | 预期 |
|---|---|
| `daemon start` | daemon PID + UI Host PID 各 1；`tray.pid` 存在 |
| `daemon start`（再次） | 第二个进程 exit 0；已有 daemon 不受影响 |
| `-OpenCenter` 激活 | 第二实例 signal named event 后 exit 0；Center 已聚焦 |
| Center hide | Host 存活，Tray icon 继续显示 |
| `daemon stop` | Host 优雅退出（先删 `tray-state.json`，再等 5s，最后 SIGTERM） |
| Host crash | daemon respawn 新 Host（`tray.pid` 更新） |
| daemon restart | 旧 Host 退出，新 Host 启动；无双 Tray icon |
| 旧 PS Center 残留 | 新 Host 检测 Center Mutex 占用，bounded retry 后退出非零 |

---

## 3. IPC Security Verification（TCP 通道安全）

**目标**：确认本地 TCP 通道的安全边界，特别是防止任意本地进程通过 `cmd-jump` 操控焦点。

### Invariants（必须验证）

```
IPC-001  服务仅 bind 127.0.0.1，不 bind 0.0.0.0
IPC-002  端口范围在 35000-45000（高位随机区间）
IPC-003  `ipc-port.txt` 存在且内容为有效端口号
IPC-004  非 UI Host 进程连接时，daemon 拒绝执行写命令
IPC-005  daemon restart 后 UI 能读取新端口并重建连接
IPC-006  端口冲突时 daemon 选下一个随机端口，不 crash
```

### 攻击面测试

```powershell
# 测试 1：其他进程能否连接并发送命令
$port = Get-Content "$env:USERPROFILE\.agent-attention\ipc-port.txt"
$tcp = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $port)
# 发送非法帧 → 预期：连接被拒绝或收到 error ack
# 发送 cmd-jump → 预期：拒绝（无认证 token）

# 测试 2：端口扫描
127.0.0.1:35000..45000 | ForEach-Object {
    try {
        $t = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $_)
        Write-Host "OPEN: $_"
        $t.Close()
    } catch {}
}
# 预期：只有 ipc-port.txt 中的端口开放
```

---

## 4. Package / Distribution（发布安装验证）

**目标**：确保 `npm pack → 全新安装 → 运行` 路径完整可用，无源码路径泄漏。

```bash
# 步骤 1：打包
npm pack
# 产物：agent-attention-0.2.0.tgz

# 步骤 2：全新临时目录安装
cd $env:TEMP
mkdir agt-test-clean
cd agt-test-clean
npm init -y
npm install ../../agent-attention-0.2.0.tgz

# 步骤 3：验证产物
where.exe agent-attention      # 应指向 AppData/Roaming/npm
where.exe agent-notify         # 同上
Test-Path "node_modules/agent-attention/src/center/TrayIcon.ps1"   # 应为 false
Test-Path "node_modules/agent-attention/src/center/CenterWindow.ps1" # 应为 false
Test-Path "node_modules/agent-attention/src/center/csharp/dist/win-x64/AgentAttention.UI.exe" # 应为 true

# 步骤 4：启动验证
agent-attention daemon start
Start-Sleep -Seconds 3
Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'AgentAttention.UI.exe'} | Select-Object ProcessId
# 预期：有 PID

# 步骤 5：Code.exe 无新增进程
$before = (Get-Process Code -ErrorAction SilentlyContinue).Count
agent-attention daemon start
Start-Sleep -Seconds 2
$after = (Get-Process Code -ErrorAction SilentlyContinue).Count
($after - $before) | Should -Be 0  # 不应触发 VS Code launcher
```

---

## 5. Human UX（真实 Windows UI 验收）

**目标**：在真实显示器上验证用户感知层面的体验。

| 场景 | 验收标准 |
|---|---|
| Tray icon 外观 | 无事件：灰阶 icon；有未读：红点 overlay |
| Tray click 响应 | 单击：显示/隐藏 Center；双击：mark-all-read |
| Center 视觉质量 | WPF 渲染正常，无 DPI 模糊，字体清晰 |
| 音效 | P0 事件播放 SystemSounds.Asterisk + Hand |
| Toast 出现 | Windows 操作中心可见，含标题/消息/按钮 |
| Toast View 点击 | 激活已有 Center 窗口并置顶 |
| Toast Dismiss 点击 | 调用 `mark-all-read`，Toast 消失 |
| Jump 聚焦 | 目标终端窗口获得键盘焦点（非只是 Z-order 前移） |
| 长时间运行 | 24h 后句柄数稳定，无增长趋势 |

---

## 判定标准

| 类别 | PASS 条件 |
|---|---|
| Behavioral Parity | 上表 9 项全部通过 |
| Process Lifecycle | 上表 8 项全部通过 |
| IPC Security | IPC-001 ~ IPC-006 全部验证；攻击面测试无漏洞 |
| Package / Distribution | 步骤 1-5 全部通过 |
| Human UX | 上表 9 项全部通过 |

**整体判定**：5/5 类别通过 → Post-Migration Acceptance **PASS**
任意类别不通过 → 记录缺陷，标记为 **CONDITIONAL PASS**，注明阻塞项。
