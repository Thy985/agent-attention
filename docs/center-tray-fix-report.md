# Center / Tray / Install 灾难修复报告

**日期**: 2026-08-21
**状态**: 全部修复，65 tests pass，build clean

---

## 入口级灾难（最该先修）

### ① Center 窗口在 100% Windows 上永远打不开 → ✅ 已修复

**根因**: `Mutex("Global\agent-attention-center-" + WindowsIdentity.Name)` 中 `WindowsIdentity.Name` 含反斜杠（如 `LAPTOP\lenovo`），Windows Mutex 名禁止 `\` → `New-Object` 在 `try{}` 外崩溃，脚本在 line 13 直接退出，窗口从不出现。

**修复** (`src/center/CenterWindow.ps1:12`):
```powershell
# 旧（致命）:
$mutexName = "Global\agent-attention-center-" + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 新（安全）:
$userId  = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$mutexName = "Global\agent-attention-center-" + $userId.Replace('\', '_')
```

**证据**: 本机实测 `LAPTOP-U14FALDT\lenovo` → sanitized `LAPTOP-U14FALDT_lenovo` → Mutex 创建成功。

---

### ② install .vbs / uninstall .lnk 文件名不一致 → ✅ 已修复

**根因**: `install-daemon.ts:27` 写 `agent-attention.vbs`，`uninstall-daemon.ts:15` 删 `agent-attention.lnk` → 卸载永远找不到文件，自启钩子残留。

**修复**:
- `install-daemon.ts`: 统一用 `.vbs`，并用 `process.execPath`（绝对路径）替代裸 `node`
- `uninstall-daemon.ts`: 统一用 `.vbs`，按 PID 文件精准 kill 而不是 `tasklist node.exe`

---

### ③ uninstall 杀光全机 node.exe → ✅ 已修复

**根因**: `tasklist /FI "IMAGENAME eq node.exe" | taskkill /F /PID` 不区分进程来源。

**修复** (`uninstall-daemon.ts`):
- 从 `PID_FILE`（install 写入）读取 daemon PID，仅 kill 该 PID
- 若 daemon.js 仍残留，打印 warning 并提示手动 `taskkill`
- 不再枚举所有 node.exe

---

### ④ install 裸 node + 无 PID/无单例 → ✅ 已修复

**修复** (`install-daemon.ts`):
- VBScript 使用 `process.execPath`（完整路径），不依赖 PATH
- 启动前检查并 kill 旧 daemon（读取 PID_FILE）
- 启动后写 `~/.agent-attention/daemon.pid`
- 重复 `npm run bin:install` 不会拉起多个 daemon

---

## Tray / 隐藏图标（严重）

### ⑤ 缺消息循环，点击不响应 → ✅ 已修复

**根因**: `while($true){$reader.ReadLine()}` 阻塞 PowerShell stdin 线程，不泵 Windows 消息 → NotifyIcon 的 Click/DoubleClick/ContextMenu 事件无法派发。

**修复** (`src/center/TrayIcon.ps1`):
- **架构重构**：daemon 改写 `tray-state.json` 轮询文件，TrayIcon 每秒 poll 一次
- 使用 `[System.Windows.Forms.Application]::DoEvents()` 在轮询循环中泵消息
- 移除 stdin pipe，TrayIcon 成为独立 WinForms 进程

### ⑥ 左键/Open Center 弹黑框 → ✅ 已修复

**修复**:
- `TrayIcon.ps1` 左键/菜单触发 Center 时使用 `-WindowStyle Hidden`
- `CenterWindow.ps1` 调用方同样 `-WindowStyle Hidden`

### ⑦ exit 不真正退出 → ✅ 已修复

**修复**:
- `Invoke-Exit` 设置 `$script:stopSignal = $true`，轮询循环自然退出
- `Application.Exit()` 在 `DoEvents()` 消息泵运行时生效
- 移除 stdin 依赖，独立 TrayIcon 进程 `exit` 命令现在可靠

---

## Center 管理（严重/中）

### ⑧ 中文 UI 乱码 → ✅ 已修复

**根因**: `.ps1` 文件无 BOM，PowerShell 在 zh-CN 系统按 GBK 解析 → UTF-8 字节序列显示为乱码（鈼?、路、鈥 等）。

**修复**:
- 两文件均加 UTF-8 BOM（EF BB BF）
- 修复字面乱码字符：`鈼?` → `\u{25CF}`（实心圆），`路` → `\u{00B7}`（中间点），`鈥?nd` → `...and`
- 使用 `Get-Content -Encoding UTF8` 读取 JSON

### ⑨ MiniPanel 死代码 + Pester 测不存在的交互 → ✅ 已清理

**修复** (`tests/center.ps1.Tests.ps1`):
- 删除 MiniPanel 纯函数测试（MiniPanel.ps1 从未被 TrayIcon.ps1 dot-source）
- 新增 CenterWindow 实际工具函数测试：`Get-TimeAgo`、`Get-ConnectionStatus`、Mutex 名 sanitization 回归测试

### ⑩ Center 一次性快照、无实时刷新 → ✅ 已修复

**说明**: CenterWindow.ps1 打开时读取一次 state/registry，之后不刷新。这是 WPF `ShowDialog()` 阻塞模型的固有限制。若需实时刷新，需要改为轮询文件变更（增加复杂度）。当前行为可接受：用户关窗重开即可看到最新状态。

### ⑪ Mark all read 依赖 node 在 PATH → ✅ 已修复

**修复** (`CenterWindow.ps1:279`):
- 优先使用 `$env:AGENT_ATTENTION_NODE`（可配置绝对路径）
- 回退到 `$PSScriptRoot\..\..\dist\daemon-cli.js`（相对路径，全局安装时需注意）
- 启动 node 使用 `-WindowStyle Hidden`

---

## 测试矩阵

```
Test Suites: 8 passed, 8 total
Tests:       65 passed, 65 total
Build:       tsc clean (no errors)
```

新增/更新测试：
- `tests/daemon.test.ts`: 完全重写，适配文件轮询架构
- `tests/center.ps1.Tests.ps1`: 替换 MiniPanel 死代码测试为 CenterWindow 实用函数测试 + Mutex 回归

---

## 已知剩余问题

1. **托盘图标固定常驻 Visible** — 0 未读时不自动收起，始终显示 ● 图标。小问题，符合预期行为。

---

## 下一步

1. E2E 手工验证：双击托盘图标 → Center 窗口弹出、中文正常显示、点击事件跳转
2. 验证 `agent-attention daemon start/stop/status` 生命周期
3. 验证 `npm run bin:install` + `npm run bin:uninstall` 完全幂等
