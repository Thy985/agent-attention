# 全面 Bug 调查报告（基于 SYSTEM_MAP，2026-08-21）

> 方法：按 SYSTEM_MAP 的节点划分，派出 3 个并行子代理（PowerShell UI / TS 后端 / 入口通知链路）**实读源码 + 实跑取证**。每条均带回 `file:line` + 代码 + 验证方式（PowerShell/node 实跑结果）。未改动任何源文件。
>
> 严重程度沿用 P0–P3。架构决策（非 bug）单列，避免诱导过度重构（见 SYSTEM_MAP §6.2）。

---

## 一、P0 — 用户可见、真实交互路径已被证伪（优先修）

### P0-1 `.GetNewClosure()` 令 Tray 事件处理器的 `$script:` 状态全部失效
- **file:line**：`src/center/TrayIcon.ps1:141 / :174 / :189 / :273 / :289 / :335`（6 处 `.GetNewClosure()`）
- **证据**：实跑复现——闭包内 `$script:notifyIcon` / `$script:stopSignal` / `$script:StatePath` 等读到 `$null`、写入不落真实作用域。`Start-Tray` 内因有局部 `$cliPath` 侥幸同名，但 `suppressClick/clickTimestamp/currentState/StatePath/stopSignal` 无同名局部 → 全 `$null`。
- **后果（三重叠加）**：(1) Exit 菜单 `:189`：`$script:notifyIcon.Visible=$false` 因 `$null` 抛"找不到属性"；`stopSignal=$true` 写入丢失 → 轮询循环 `:376` 永不退出；且手写 `DoEvents` 循环非 `Application.Run`，`Application::Exit()` 不生效 → **点 Exit 什么都不会发生**。(2) 点 Exit 处理器 `$null.Visible=` 抛异常，`trap` 未触发 → 幽灵图标残留。
- **判定**：真实 bug（P0）。这是 F3（原 `$using:` 误用）的**系统性升级**——根因是 `.GetNewClosure()` 把 scriptblock 绑到新动态模块，导致所有 `$script:` 变量失效，而非仅 `$using:` 三处。

### P0-2 点击托盘 → 处理器抛异常 → 隐藏模态框 + daemon 判活失效永不重启
- **file:line**：`TrayIcon.ps1:264-271`（触发）、`:378`（`DoEvents` 在 `:381` try/catch **之外**）、`daemon.ts:105-114`（判活）
- **证据**：实跑忠实复现点击路径——`Split-Path $null` 抛"参数是空值"；即便绕过，`Start-Process -ArgumentList` 含 `$null` 抛 `ParameterBindingValidationException`。最关键的确定性复现：用 WinForms Timer+DoEvents 重放，异常在 `DoEvents` 内抛出后 loop 永不结束，弹出 `Microsoft .NET Framework` 未处理异常对话框且**挂死**（需手动 kill）。
- **后果**：托盘以 `-WindowStyle Hidden` 运行 → 用户看不到任何东西，只觉图标失灵；`daemon.ts:108` `process.kill(pid,0)` 认为进程还活着 → **永不重启**；`:33` trap 未触发 → 幽灵图标。
- **判定**：真实 bug（P0）。用户可见头号症状"点托盘图标后整个托盘死掉"。

> **修复杠杆**：P0-1 + P0-2 同源于 `.GetNewClosure()`，移除全部 6 处（普通 scriptblock 即可正确访问 `$script:`，已实测）并把 `DoEvents()` 移入 try/catch + 挂 `Application.ThreadException` 兜底，一处修完"点图标死/Exit 无效/双击崩"同时解决。

## 二、P1 — 高价值功能缺陷

| # | 标题 | file:line | 证据 / 验证 | 发现方 |
|---|---|---|---|---|
| P1-1 | Toast `actions` 传对象数组 → 按钮渲染成 `[object Object]`，语义全丢 | `win32.ts:41-44` + node-notifier `utils.js:435` | 实跑 `options.actions.join(';')` → `"[object Object];[object Object]"` | entry |
| P1-2 | Toast 回调键 `response==='activate'` 仅"点正文"命中；"View"按钮返回 `'view'` → 两分支都不触发 | `win32.ts:47-64` + `toaster.js:91` / `utils.js:247` | 源码追溯：按钮点击 `activationType`=标签，`toLowerCase` 后不匹配 `/^activate|clicked$/` | entry |
| P1-3 | `centerPath` off-by-one：`dist/src/center/CenterWindow.ps1` 三形态均找不到 | `win32.ts:31` | 实跑：`dist/src/...` exists=false、`src/src/...` exists=false；`tsc` 不复制 `.ps1` | entry（F2 补强） |
| P1-4 | `getDaemonCliPath` 回退 `dist/dist/daemon-cli.js` 不存在 | `win32.ts:13` + `:62` | 实跑：`dist/dist/daemon-cli.js` exists=false | entry |
| P1-5 | `daemon.ts` 的 `cliPath` 回退 `dist/dist/daemon-cli.js` 不存在（同式 off-by-one） | `daemon.ts:237` | 同 P1-4 推导（`__dirname=dist` → `dist/dist/...`） | ts |
| P1-6 | 去重跨进程 100% 失效：模块级 `Map` 每次 `agent-notify` 启动重建，TTL 随进程退出消失 | `dedup/index.ts:7,36-37` | 实跑：两独立进程同参 `shouldNotify` 均返回 `true`（应为 false） | entry |
| P1-7 | `readState` 每次读取都重写文件 → chokidar `change` 死循环 + 与 `recordEvent` 写竞态 | `AttentionState.ts:65-67` + `daemon.ts:74-91,163-166` | 实跑：5 次纯 readState 触发 chokidar 5 次 `change`，mtime 改变 | ts |
| P1-8 | 单实例守卫是空壳：`LOCK_FILE` 从未写入，`writePid` 非原子 → 并发 `start` 起两个 daemon | `daemon-cli.ts:38,65-68,212-256` | grep 证实 `LOCK_FILE` 仅 `unlink` 从不写；两条 `start` 在彼此 spawn 前都看不到对方 | ts |
| P1-9 | Center 逐条 ✓：`RemoveChild` 方法根本不存在（应为 `Children.Remove`） | `CenterWindow.ps1:537` | 实跑：`[StackPanel] 不包含名为"RemoveChild"的方法`，children 未减 | ps |
| P1-10 | `AGENT_ATTENTION_NODE` 默认未设 → `Start-Process $null` 抛异常被空 catch 吞；且此处唯独漏 `'node'` 兜底 | `CenterWindow.ps1:534-536` | 实跑：`Start-Process $null` THREW 参数验证空；grep `env:AGENT_ATTENTION_*` 在 daemon/win32 全无设置 | ps |
| P1-11 | `TrayIcon.ps1:235` `$script:cliPath = $CliPath` 把已解析回退路径丢弃 → 双击 mark-all-read 静默失效 | `TrayIcon.ps1:224-235` | 代码审查：`:225-234` 整段 fallback 写进局部 `$cliPath`，`:235` 却写回原始参数 | ps |
| P1-12 | `Start-Sleep` 直接阻塞单线程 UI（Center 2s / Tray 500ms）→ 窗口/菜单"卡死" | `CenterWindow.ps1:374,621`；`TrayIcon.ps1:378,400` | 代码审查：WPF 消息泵与窗口同线程，每周期整段不泵消息 | ps |
| P1-13 | `Get-TimeAgo` 24h+ 渲染 `[d ago]`（缺数字） | `CenterWindow.ps1:65-75` | 实跑：`"${[math]::Floor($h/24)}d ago"` → `[d ago]` | ps（F4 确认） |
| P1-14 | `jumpToTarget` 死代码：src/ 零生产调用 | `jump.ts:13` | Grep `src/` 仅定义本身 + tests/docs/dist；零调用方 | entry（F1 确认） |

> **P1 修复杠杆（最高杠杆顺序）**：P1-1+P1-2（让 Toast 按钮可用且回调正确）→ P1-3/P1-4/P1-5（路径用 `path.join(__dirname,'..','..','src','center',...)` 或构建期复制 `.ps1` 到 `dist/center/` 并改用 `dist/center`；cliPath 改用 `path.join(__dirname,'daemon-cli.js')`）→ P1-6（去重挪到 daemon 长驻进程或基于 `state.json` 的磁盘级去重）→ P1-7（仅当 `unreadCount/visible` 真变才回写）。

## 三、P2 — 中危

| # | 标题 | file:line | 证据 / 验证 | 发现方 |
|---|---|---|---|---|
| P2-1 | `killExistingDaemon` PowerShell `$_ .name` 语法错（变量与点间空格）→ 整段抛 ParserError 被吞，旧 tray 子进程永不杀 | `daemon-cli.ts:194-197` | 实跑：PowerShell 报 `UnexpectedToken ".name"`；try/catch 吞掉 | ts |
| P2-2 | `markAgentEventsRead` 的 `visible` 用错字段（`events.length>0` 应为 `unreadCount>0`）→ 零未读时图标仍常驻 | `AttentionState.ts:207` | 实跑：markAgentEventsRead 后 `unread=0 visible=true` | ts |
| P2-3 | `doctor` 的 "Daemon instances" 永远 ≤1，无法发现多实例（与启动扫描自相矛盾） | `daemon-cli.ts:367-371` | 代码审查：只数 PID 文件 1 个 pid，不扫进程 | ts |
| P2-4 | daemon 非原子写 `tray-state.json` + 500ms 轮询半写竞态，异常被空 catch 吞 | `daemon.ts:86` vs `TrayIcon.ps1:381-398`；`AttentionState.ts:82` 对比已用原子写 | 实跑：`ConvertFrom-Json` 半写文件 THREW 未终止字符串；空 catch 无日志 | ps |
| P2-5 | 事件为空时 `Update-NotifyIcon` 永不被调用（比较键只覆盖 `events`，漏 `visible/unreadCount`）→ 空闲期幽灵图标 | `TrayIcon.ps1:245,385-394` | 实跑：`oldJson==newJson`(`[]` vs `[]`) → `Update-NotifyIcon` 被跳过 | ps |
| P2-6 | `Add_Closed` 空 catch 掩盖 `$using:` 菜单重建 bug（"menu always fresh" 从未生效）+ 旧 `ContextMenuStrip` 从不 Dispose（GDI/USER 泄漏） | `TrayIcon.ps1:196-211,393` | 代码审查：`:207` 抛 NullReferenceException 被 `:208` 吞；全文件无菜单 Dispose | ps |
| P2-7 | `Icon::FromHandle` 的 HICON 从不 `DestroyIcon` → 每次刷新泄漏一个 USER 对象 | `TrayIcon.ps1:94-102,240` | 静态判定（.NET 契约：FromHandle 需调用方 DestroyIcon）；实跑探针因环境限制未取得数字 | ps |
| P2-8 | Center 每 2s 整树重建：滚动位置丢失 + 首帧 UI 立即被丢弃（`$lastRefreshHash=''` vs `$null`）+ 初建/重建两份不一致 UI | `CenterWindow.ps1:361,381-615` vs `:125-344` | 代码审查：初值 `''` 使首帧必重建；重建版才有逐条 ✓ 按钮 | ps |
| P2-9 | `daemon.pid` 仅 CLI 写；直接 `node dist/daemon.js` 时文件不存在 → 托盘 1s 重生死循环 | `TrayIcon.ps1:343-346` + `daemon.ts:230-248` | 代码审查：`daemon.pid` 仅 `daemon-cli.ts:255` 与 `install-daemon.ts` 写 | ps |
| P2-10 | 每 500ms 一次 WMI 查询（开销高于 `Get-Process`）+ 任何瞬时异常 `catch{return $true}` → 托盘无谓退出 | `TrayIcon.ps1:347-354` | 实跑 `[int]` 边界：空文件安全，`仅含换行` 中间态会抛 → return $true | ps |
| P2-11 | `Start-Process -ArgumentList` 元素未加引号 → 用户名含空格时 StatePath 被截断 | `TrayIcon.ps1:265-271,133-139` | 静态判定 + Windows 命令行分词既知行为（沙箱拦截端到端实跑） | ps |
| P2-12 | `wait:true` 阻塞 `agent-notify` 进程直到用户交互才写 `state.json` | `win32.ts:34-68` + `index.ts:86-106` | 源码追溯：`await notify` 后才 `recordEvent`/`process.exit` | entry |
| P2-13 | 托盘 `trayScriptPath` 在发布态解析正确（package 已发布 `src/center/*.ps1` 且 `dist/../src/center` 命中），但 `cliPath` 仍 off-by-one（见 P1-5） | `daemon.ts:236-237` | 修正：P1-5 仅 cliPath 错，trayScriptPath 因包布局实际可用 | ts（修正 F2 精度） |

## 四、P3 — 低危 / 潜伏 / 可观测性

| # | 标题 | file:line | 证据 / 验证 | 发现方 |
|---|---|---|---|---|
| P3-1 | 缺 `read` 字段旧事件 `$_.read=$true` 抛"找不到属性"（PSCustomObject 不自动加属性） | `TrayIcon.ps1:287` | 实跑：`set .read FAILED` | ps |
| P3-2 | WPF `Window` 无 `IsDisposed`，4 处守卫 `-not $w.IsDisposed` 恒为 `$true`（靠巧合工作，加 `Set-StrictMode` 即崩） | `CenterWindow.ps1:321,338,352,373` | 实跑：`Window.IsDisposed` 不存在，`-not $null`=True | ps |
| P3-3 | Center CLI 探测硬编码 mise 路径 + 把 `.cmd` 当 node 脚本参数 | `CenterWindow.ps1:33-38,535` | 代码审查：本项目在 `D:\Projects\Active`，`..\..\..` 落到 `D:\Projects`，必然找不到 | ps |
| P3-4 | Center 单实例仅 `exit 0` + `Write-Warning`（隐藏），不前置/闪烁已有窗口 | `CenterWindow.ps1:17-27` | 代码审查 | ps |
| P3-5 | `Get-ConnectionStatus` 缺中间档，陈旧 agent 显示 "Last seen 4320m ago"；`minsAgo<0` 误显 Connected | `CenterWindow.ps1:77-83` | 代码审查 | ps |
| P3-6 | `doctor` Sound/Toast 假阳性（Sound 仅看 platform；Toast 仅查文件存在，且文案写 snoretoast 实为 node-notifier） | `daemon-cli.ts:409-419` | 代码审查 | ts |
| P3-7 | `uncaughtException` 只删文件不 `trayProc.kill()`；`pushStateToTrayFile` 无 `stopped` 守卫 → stop 期间可能重建 tray-state.json | `daemon.ts:254-267,74-99` | 代码审查 | ts |
| P3-8 | registry 非原子写 + 并发覆盖；`autoDetectAndRegister` 未设 `AGENT_ID` 时恒注册 `'agent'` → 多 agent 目标互相覆盖 | `registry.ts:39-42,140-152` | 代码审查 | ts |
| P3-9 | `restart` 固定 1s 延迟与优雅停止（最多 5s）竞态，重启瞬间可能双 daemon 短暂并存 | `daemon-cli.ts:354-358` | 代码审查 | ts |
| P3-10 | `agent_name` 被写成 `agent_id`（友好名丢失） | `index.ts:96-97` + `registry.ts:140-152` | 源码追溯：`autoDetectAndRegister` 只返回 id | entry |
| P3-11 | `AGENT_ID` 缺失静默回退 `'agent'` → 去重键/数据塌缩（修好 P1-6 后不同真实 agent 会互吞通知） | `registry.ts:149-151` | 源码追溯 | entry |
| P3-12 | Toast 动作错误被空 `catch {}` 吞没（无 `console.warn`） | `win32.ts:57,63,89,121` | 源码追溯 | entry |

## 五、已确认 / 已知项复核 + 架构决策（不要据此重构）

- **F1 `jumpToTarget` 死代码**：entry 子代理 Grep 确认 src/ 零生产调用 → 维持 P1 / 验收 blocker 判定。
- **F2 `dist/src` 悬空**：精度修正——`win32.ts:31` 的 `centerPath` 是真·悬空（P1-3），`daemon.ts:236` 的 `trayScriptPath` 因 `package.json` 已发布 `src/center/*.ps1` 且 `dist/../src/center` 命中而**实际可用**；但 `daemon.ts:237` 的 `cliPath` 同样 off-by-one（P1-5）。定位仍为 **Release-blocking**。
- **F3 `$using:` 误用**：升级为系统性 P0（`.GetNewClosure()` 6 处致全部 `$script:` 失效，见 P0-1/P0-2）。
- **F4 `Get-TimeAgo`**：确认仍坏（P1-13）。
- **`priority` 字段**：entry 子代理确认——影响声音（P0 走急响）与展示色，**不影响排序**（无 `sort`）。属**架构决策，非 bug**。
- **F5（Center 直读 State/Registry）/ F6（双事实源）**：维持 SYSTEM_MAP §6.2 判定——非 bug，需补一致性契约而非重构。本轮新发现未推翻此判定。

---

## 六、修复优先级建议（最高杠杆）

1. **P0-1 + P0-2**：移除 TrayIcon.ps1 全部 6 处 `.GetNewClosure()`，并把 `DoEvents()` 包进 try/catch + `Application.ThreadException` 兜底。一处修完"点图标死/Exit 无效/双击崩"。
2. **P1-1 + P1-2**：`actions` 改字符串数组 `['View','Dismiss']`；回调键按按钮标签（`view`/`dismiss`）而非 `'activate'` 判定（或改 node-notifier 用法）。
3. **P1-3/P1-4/P1-5**：统一路径解析——构建期复制 `.ps1` 到 `dist/center/`，代码改用 `path.join(__dirname,'..','center',...)`（win32 从 `dist/notification` 需 `../..`）；cliPath 用 `path.join(__dirname,'daemon-cli.js')`（daemon 从 `dist`）/ `path.join(__dirname,'..','dist','daemon-cli.js')`（win32 从 `dist/notification`）。
4. **P1-6**：去重迁到 daemon 长驻进程，或改基于 `state.json` 的磁盘级去重（TTL 持久化）。
5. **P1-7**：`readState` 仅在 `unreadCount/visible` 真变时回写，断开 chokidar 写循环。
6. **P1-8**：`LOCK_FILE` 真正写入（O_EXCL 原子）+ `writePid` 改用 `wx` 标志或原子 rename，挡住并发双 daemon。
7. 其余 P2/P3 按编号推进，其中 P2-6/P2-7/P2-8 属长时运行资源泄漏，建议一并处理。

---

## 七、子代理排除的误报（实跑证伪，避免改错）

| 怀疑点 | 结论 |
|---|---|
| 闭包内调用 `Mark-EventRead`/`Update-NotifyIcon` 找不到函数 | 不是 bug：函数仍可解析，仅变量失效 |
| `CenterWindow.ps1:351` 用 `$_` 取 KeyEventArgs（Escape 关窗） | 不是 bug：`$_` 确绑定 EventArgs |
| `Set-Content -Encoding UTF8` 写 BOM 破坏 node 解析 | 不是 bug：`AttentionState.ts:53` 已显式剥 BOM |
| `daemon.pid` 带 BOM/空文件致 `[int]` 崩 | 基本不是 bug：`Get-Content -Raw` 剥 BOM，空→`$null`→0 安全跳过 |

---

## 八、修复记录（2026-08-22，按第六节杠杆顺序执行）
> 每条含：改动文件、修法、验证方式与结果。验证级别标注：L1=单测 / L2=CLI 实跑 / L3=Windows 实机。

### P0（真实交互路径）

| # | 修法 | 文件 | 验证 |
|---|---|---|---|
| P0-1 | 移除全部 6 处 `.GetNewClosure()`；处理器改用 `$script:` 作用域变量；`Start-Tray` 显式写入 `$script:cliPath`/`$script:StatePath`/`$script:trayStatePath` 供闭包外处理器读取 | `src/center/TrayIcon.ps1` | L3：静态守卫脚本 PASS；实机 daemon 起停 + tray 存活轮询正常 |
| P0-2 | `DoEvents()` 包入 try/catch（原有 `Application.ThreadException` 兜底保留），异常只记 Warning 不再挂死轮询循环 | 同上 | L3：同上；托盘在事件风暴下持续响应 |

### P1

| # | 修法 | 文件 | 验证 |
|---|---|---|---|
| P1-1 | `actions` 改字符串数组 `['View','Dismiss']`（snoretoast `-b` 期望 `label1;label2`） | `src/notification/win32.ts` | L1：源码/编译产物断言 PASS |
| P1-2 | 回调按小写化后的 activationType 分派：`view`/`activate`→开 Center，`dismiss`→mark-all-read；空 catch 改为 console.warn | 同上 | L1 PASS；L2 待人工点 Toast |
| P1-3 | 新增 `getCenterPath()`：env 覆盖 → `path.join(__dirname,'..','..','src','center','CenterWindow.ps1')`（编译态 dist/notification → 项目 src/center） | 同上 | L2：`scripts/verify-win32-paths.js` 7/7 PASS（解析路径 exists=true） |
| P1-4 | `getDaemonCliPath` 改为 `path.join(__dirname,'..','daemon-cli.js')`。**注意**：初版误用同级 `'./daemon-cli.js'`，被 verify 脚本抓出后修正为上一级 | 同上 | L2：解析到 `dist/daemon-cli.js` exists=true |
| P1-5 | daemon 入口 cliPath 直接取 `path.join(__dirname,'daemon-cli.js')`（dist/daemon.js 与 dist/daemon-cli.js 同级），删除先探坏路径的冗余逻辑 | `src/daemon.ts` | L1+L2 PASS |
| P1-6 | 去重持久化到 `<home>/.agent-attention/dedup.json`（原子写 tmp+rename）；进程内 Map 作快路径；支持 `AGENT_ATTENTION_HOME` 覆盖根目录 | `src/dedup/index.ts` | L2：两个独立 node 进程实测 proc1=true / proc2=false（修复前必为 true/true） |
| P1-7 | `readState` 仅在 `unreadCount`/`visible` 真变化时回写文件 | `src/state/AttentionState.ts` | L1：mtime 前后不变断言 PASS |
| P1-8 | **设计修订**：锁由 daemon 进程持有（非短命 starter CLI）——O_EXCL(`wx`) 原子获取 + 死持有者偷取陈旧锁；SIGTERM/SIGINT/crash/beforeExit 全路径释放；CLI start 只清理"持有者已死"的锁；CLI stop 无条件清 lock/pid/tray 生命周期文件 | `src/daemon.ts`, `src/daemon-cli.ts` | L3 实机：start 后 lock pid==daemon.pid 且 alive；stop 后 4 个生命周期文件全消失；立即重启不被阻塞 |
| P1-9 | `$s.Parent.RemoveChild($s)` → `$s.Parent.Children.Remove($s)`；同时补 node 兜底 | `src/center/CenterWindow.ps1` | L3 静态守卫 PASS（RemoveChild 零残留） |
| P1-10 | 三处 `$env:AGENT_ATTENTION_NODE` 使用点全部带 `'node'` 兜底 | 同上 + TrayIcon.ps1（已有） | L3 静态守卫 PASS |
| P1-11 | `$script:cliPath = $cliPath`（解析后的局部值），并新增 `$script:StatePath = $StatePath` | `src/center/TrayIcon.ps1` | L3 静态守卫 PASS |
| P1-13 | 24h+ 分支先算 `$days = [math]::Floor($hours/24)` 再插值 | `src/center/CenterWindow.ps1` | **L3**：`scripts/verify-timeago.ps1` 从真源码抽取函数实测边界矩阵 10/10 PASS（0s/59s/60s/59m/60m/23h59m/**24h=1d ago**/48h/7d） |
| P1-14 | 接通死代码：新增 CLI 命令 `agent-attention jump <agent-id>` → 读 registry target → `jumpToTarget` | `src/daemon-cli.ts` | L2：help 显示命令；未注册 agent 报错 exit=1 |

### P2/P3（顺带修复）

| # | 修法 | 文件 | 验证 |
|---|---|---|---|
| P2-1 | 删除 kill 子 tray 的 PS 片段中管道变量与属性间的空格（ParserError 根因） | `src/daemon-cli.ts` | L1 正则断言 PASS |
| P2-2 | `markAgentEventsRead` 的 `visible` 改为 `newUnreadCount > 0` | `src/state/AttentionState.ts` | L1：归零后 visible=false 断言 PASS |
| P2-3 | doctor 的 Daemon instances 改为 PID 文件 ∪ 进程扫描去重计数 | `src/daemon-cli.ts` | L3：实机 doctor 输出 `Daemon instances 1 instance(s)` 且全绿 |
| P3-7 | `pushStateToTrayFile` 加 `stopped` 守卫，防 stop 后重建 tray-state.json | `src/daemon.ts` | L1 断言 PASS |
| 附带 | daemon.log 改惰性初始化 + error 监听，消除模块加载期与并行测试 worker 删目录的竞态（ENOENT flake 根因） | `src/daemon.ts` | L1：全套件连续 3 次 86/86 稳定 |

### 本轮新修（2026-08-30）

| # | 修法 | 验证 |
|---|---|---|
| P2-12 | `notify()` 增加硬性超时保护：`Promise.race` 风格的 `done()` + `setTimeout(hardTimeout)`，默认 30s，`AGENT_ATTENTION_NOTIFY_TIMEOUT_MS` 可覆盖；`agent-notify` 进程永不在 toast 交互上无限挂起（node-notifier 的 wait/timeout 在 Windows 被 toaster 标志过滤，无法自限时） | L1：jest mock node-notifier 永不回调，`notify()` 100/50/25ms 超时均按时返回（<2s）；L2：实机 `agent-notify` 2.5s 返回 exit=0 事件落盘 |
| P3-6 | `doctor` Sound/Toast 文案修正：snoretoast → node-notifier；Sound 改为依赖 daemon 运行状态而非单纯 platform 判断 | L2：`agent-attention doctor` 输出准确 |
| P3-8 | `writeRegistry` 改用原子写（tmp + rename），与 `AttentionState.atomicWrite` 一致 | L1：源码断言 PASS |
| P3-10 | `autoDetectAndRegister` 返回值改为 `{agentId, agentName}` 对象，`index.ts` / `hooks.ts` / `daemon-cli.ts` 全部接入，事件记录时 `agent_name` 正确写入 | L2：hook E2E 验证 `agent_name: claude-code` 正确落盘 |
| P3-12 | `win32.ts` Toast 回调空 catch 改为 `console.warn` | L1：源码断言 PASS |

### 已修复（C# 迁移时一并解决）

- **P1-12** `Start-Sleep` 阻塞 → C# 使用 `DispatcherTimer`，非阻塞
- **P2-4** tray-state 竞态 → C# 侧读，daemon 侧原子写，无半写
- **P2-5** 比较键补全 → C# `TrayController` 签名含 `visible|unreadCount|events`
- **P2-6/P2-7** GDI/USER 泄漏 → C# `Dispose()` + `DestroyIcon()` 在 `Dispose()` 中统一处理
- **P2-8** Center 整树重建 → C# 增量刷新
- **P2-9~P2-13** → C# 无对应代码
- **P3-1~P3-5** → PowerShell 时代 bug，已随迁移消失

### 验证汇总（2026-08-30，P3+P2-12 修复轮）

- Jest 单测：**204/204 PASS**（26 suites，连续稳定）
- P2-12 回归：`tests/p2-12-timeout.test.ts` 6/6（mock node-notifier 永不回调，超时保护按时返回）
- P2-12 实机 E2E：`AGENT_ATTENTION_NOTIFY_TIMEOUT_MS=2000 node dist/index.js completed "..."` → 2.5s 返回，exit=0，事件正确落盘
- Hook E2E：`echo '{"sessionId":"test123","exitStatus":0,"turns":5}' \| node dist/daemon-cli.js hook` → state.json `agent_id=claude-code, agent_name=anonymous`（无 AGENT_ID 时正确回退）
- `agent-attention integration list`：6 agent 正常显示
- `agent-attention integration status claude-code`：L3 hook verified ✓
- `agent-attention doctor`：Sound 显示 daemon 运行状态，Toast 显示 node-notifier

- Jest 单测：**86/86 PASS**（10 suites，连续 3 轮稳定），含本轮新增回归：dedup 跨进程持久化、readState 无变更不回写、markAgentEventsRead visible、win32 路径/动作、daemon 锁语义、jump 接线。
- PowerShell 守卫：`scripts/verify-ps1-guards.ps1` **9/9 PASS**。
- Get-TimeAgo 边界 oracle：`scripts/verify-timeago.ps1` **10/10 PASS**（真源码抽取执行）。
- win32 编译路径：`scripts/verify-win32-paths.js` **7/7 PASS**。
- Windows 实机 E2E：daemon start → tray 就绪 → recordEvent → tray-state.json 传播(unread=1) → mark-all-read(visible=False 传播) → doctor 全绿 → stop 四文件清净 → 立即重启成功 → 并发 start 自动替换且进程数恒 1 → 最终优雅停止。
- Pester：环境仅 Pester 3.4.0，不支持测试文件的 Pester4+ `Should -Op` 语法（**既有限制，非本轮引入**）；已用上述免 Pester 脚本替代取证。

---

## 九、"state.json corrupted" 根因调查与修复（2026-08-30）

### 现象
运行时日志（`runtime.jsonl`）反复出现 `state_read_failed: state.json corrupted, using defaults`，
累计 82 条，分布在 08-27 ~ 08-30。初判为生产腐蚀红旗。

### 调查方法（实读源码 + 实跑取证）
1. **静态排查写入者**：grep 全仓 `state.json` 的所有写入点。
   结论：所有生产 TS 写入者（`AttentionState.atomicWrite`、`readState` 修正路径、`commands`、
   `daemon`、`pipeline/ipc`）均走 tmp+rename 原子写；C# UI 只读不写。无生产非原子写入者。
2. **复现取证**：
   - 单进程 200× `concurrent` 场景：0 次腐蚀。
   - **多进程 30 批 × 6 进程**（真实生产形状）：`state.json` **从未变成非法 JSON**（全部 `parsed: ok`）。
   但暴露了两个真实缺陷（见下）。
3. **插桩 readState**：在 catch 里 dump 腐蚀原始字节，跑完整测试套件。
   捕获 9 个样本，**全部**位于 `D:\Temp\agent-attention-*` 临时测试目录，内容是
   `not valid json {{{`、`garbage`、`not json {{{broken` —— 即**测试故意写入的坏 JSON**。
4. **日志分析**：82 条 `state_read_failed` 的时间戳全部紧邻 `event_recorded a → completed: concurrent N`
   等测试生成事件。**生产 agent 通知（真实任务描述）从未触发腐蚀。**

### 根因判定
- **表面现象（82 条腐蚀告警）= 测试日志污染**，非生产腐蚀。`logging.ts` 固定写
  `~/.agent-attention/logs/runtime.jsonl`，**不尊重 `AGENT_ATTENTION_HOME`**（dedup/registry/telemetry 均尊重）。
  测试进程把测试临时文件的坏 JSON 读失败日志写进了生产 runtime.jsonl，造成"90 次错误"误报。
- **真实缺陷（压测复现）**：
  - **C1 事件静默丢失**：`atomicWrite` 在 Windows 上 `renameSync` 到被占用文件返回 EPERM/EACCES，
    连续 3 次重试**无退避**（全部落在同一竞争窗口内失败）→ 放弃写入 → **事件丢失**。
    多进程压测 11/30 批次触发。
  - **C2 tmp 泄漏**：`readState` 修正路径 rename 失败后**从不清理 tmp** → tmp 文件永久残留。

### 修复
| # | 改法 | 文件 |
|---|------|------|
| C1 | `atomicWrite` 改为退避重试 `[0,5,20,50,100,200]`（~375ms 窗口）覆盖 Windows 竞争窗口；真实非竞争错误仍传播；耗尽后清理 tmp + ERROR 日志（不丢也不腐蚀） | `src/state/AttentionState.ts` |
| C2 | `readState` 修正路径复用 `atomicWrite`，rename 失败时清理 tmp（修泄漏） | 同上 |
| C3 | `logging.ts` 尊重 `AGENT_ATTENTION_HOME`，根治测试日志污染生产日志 | `src/logging.ts` |
| 附 | `readState` 腐蚀日志补 `parseErr` 上下文，未来诊断一眼可见 | `src/state/AttentionState.ts` |

### 回归测试
新增 `tests/state-corruption-regression.test.ts`（6 用例，全过）：
- EPERM 退避重试后事件成功持久化、无 tmp 泄漏
- 持续 EPERM 时不抛异常、无 tmp 残留
- 非 contention 真实错误正确传播、无 tmp 残留
- `readState` 修正路径 contention 时不留 tmp（锁旧 bug）
- 日志隔离到 `AGENT_ATTENTION_HOME`（不污染真实用户目录）
- N 次并发写后 state.json 仍合法、无 tmp 垃圾

### 验证级别
- **L1 单测**：6/6 PASS。
- **L2 CLI/进程**：完整套件 **23 suites / 168 tests PASS**（从 162 增 6）。
- **L3 Windows 实机**：daemon start → 3× 真实 `agent-notify`（completed/failed）→ state.json 合法 JSON、0 tmp 残留、3 条事件正确落盘。
- **多进程压测**：修复前 11/30 批 `state_write_failed`；修复后 `parsed: ok` 全过、无 tmp 泄漏。

### 诚实结论
> 生产 `state.json` 从未被真实事件腐蚀。之前的"90 次腐蚀错误"是测试日志污染造成的误报。
> 真实可靠性缺陷（Windows rename 竞争致事件静默丢失 + tmp 泄漏）已修复并加回归测试锁死。

