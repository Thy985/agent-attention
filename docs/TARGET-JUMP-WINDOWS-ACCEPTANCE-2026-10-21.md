# Target Jump 第二轮修复与 Windows 验收（2026-10-21）

这是第一轮 IPC 补丁之后的增量，不重复包含第一轮成果。当前工作树已保留全部第一轮修改；没有提交、推送、PR 或部署。不能把本轮代码/解析器测试当作 Windows 实机已通过。

## 找到并修复的问题

原实现把包含 PowerShell here-string 的脚本所有换行替换为空格，破坏 `@"` / `"@` 的语法。用 PowerShell 7.6.7 的真实语法解析器对原始转换后脚本检测，得到 4 个解析错误。原调用忽略子进程退出码，CLI 与 RPC 仍然报成功，足以解释“命令成功但窗口没切换”的一种确定失败路径；不能据此认定所有实机失败都只有这一个原因。

本轮改成保留换行的 UTF-16LE `-EncodedCommand`，验证 PID、子进程输出/退出码，并比较目标 HWND 与 `GetForegroundWindow` 的实际结果。CLI 增加 `jump <id> --json`，失败退出 1；RPC 传播失败。成功意味着采样时目标 HWND 处于前台，不保证此后不被其他窗口抢走。最小化目标可请求正常恢复；没有模拟按键、修改前台锁策略或 AttachThreadInput 绕过系统限制。

返回原因包括 `no-target`、`invalid-pid`、`unsupported-platform`、`process-not-found`、`no-window`、`foreground-denied-or-changed`、`powershell-error`、`invalid-response`、`unverified-focus`。无窗口通常需要检查目标是否误登记成 shell 子进程，而不是实际拥有顶层窗口的终端宿主。

## 已验证与未验证

- TypeScript 编译通过。
- 25 项新增测试（Jump 19、RPC 3、真实 CLI 子进程 3）；连同既有 Jump/第一轮 TCP 回归共 41/41 通过。
- 将新增 Jump 结果测试指向原 Jump 实现，19/19 失败；换回修复实现后通过。其 Windows API 结果是模拟的，证明控制流/返回契约，不是 Windows API 动态验收。
- PowerShell 7.6.7 真实解析器：原展开脚本 4 错；修复后的原生调用脚本及验收脚本 0 错。未在 Windows PowerShell 5.1 实际执行；脚本仅使用 5.1 已有语法/API。
- 全量 Jest 33 套、275 项：263 通过、12 失败；10 项需要 Windows IPC，2 项需要已发布 Windows UI exe。没有跳过或弱化原测试。既有 heapUsed 阈值本次通过，先前有抖动，不能称已修复。
- Windows 托盘、真实 Toast/View、Center 操作、窗口激活与 daemon 重启恢复仍待交互式 Windows 桌面运行。

## Windows 最短操作路径

需要一个普通交互式 Windows 桌面（非管理员、非无头 CI），Node >=18、.NET 10 SDK，且目标窗口和应用处于同一用户会话。最好使用专门测试账户，避免已有通知历史和其他版本干扰。当前版本不同模块对 `AGENT_ATTENTION_HOME` 的支持不一致，验收脚本拒绝自定义目录，不靠临时 HOME 冒充隔离。

1. 在包含第一轮修复的项目上应用 `agent-attention-target-jump-increment.patch`。当前 Wabi 工作树已应用，不要重复打补丁。新 checkout 需先应用第一轮补丁，再 `git apply --check` 本增量并应用。
2. 在该 Windows 项目目录编译依赖和 UI（不使用 mise 的直接 .NET 命令）：

   ```powershell
   npm ci --legacy-peer-deps
   npm run build
   dotnet publish src/center/csharp/AgentAttention.UI/AgentAttention.UI.csproj -c Release -r win-x64 --self-contained true -o src/center/csharp/dist/win-x64
   ```

   这是待在 Windows 执行的准备命令，不是已验证的 Windows 发布结果。依赖安装或发布失败时保留错误，不能继续假报验收通过。
3. 使用这个 checkout 的 daemon/托盘运行。若需要 `node dist/daemon-cli.js daemon restart`，先确认可短暂中断 Agent Attention：既有命令会清理本应用进程并重新注册登录启动项；不要在其他版本仍在使用时执行。
4. 打开欲回跳的终端窗口，然后在另一个普通 PowerShell 中运行：

   ```powershell
   powershell -NoProfile -File .\scripts\verify-target-jump-e2e.ps1 -AllowRestart
   ```

   如果本机脚本执行策略拒绝执行，按你的本机信任/签名流程审核放行；本包不改变策略。脚本会列出已有目标，选择要测的一个。也可传 `-AgentId <已有agent-id>`；无已有登记时用 `-TargetProcessId <拥有可见窗口的终端宿主PID>`。没有可用目标时脚本会明确停止，不会自动猜 PID。
5. 按提示确认添加测试数据；分别看 completed/failed/input_required 的通知，点 View，在 Center 只标记指定测试行已读；提示观察回跳时只点 Center 的 Jump，不要手动点目标窗口。重启测试还需输入 `RESTART`。结束后把输出目录中的 `acceptance.json` 交回；先浏览内容再分享。

## 验收脚本做什么

`scripts/verify-target-jump-e2e.ps1` 创建一个唯一 `acceptance-*` Agent 与三个合成事件，不覆盖原有目标。顺序验证：

- 三类事件出现、Toast/View 的人工观察与实际事件落盘分别记录。
- 前两条在 Center 标记已读并检查磁盘状态；需人工事件保持未读。
- 调用 `jump --json` 记录 Win32 原生结果；另采样 Center Jump 的非目标→目标前台变化，并询问是否只点击 Jump，避免把手动切窗当作成功。
- 显式同意后执行本应用 restart；验证新 PID、三个事件/已读标记保留；重启后再标记待人工事件已读。
- 采集目标 PID/进程名/会话/窗口句柄、父进程链和前台采样。无窗口、不同会话、前台被拒绝、错误 daemon checkout 等会分开报告。
- CLI 退出 0 不等于 Toast 出现；人工观察、状态检查、通知子进程退出分别计分。NOT-RUN / UNOBSERVED / FAIL / BLOCKED 均不能算完整通过。

### 数据和安全边界

- 现有状态环最多 20 条；若初始超过 17 条，脚本拒绝新增三条，以免挤掉历史。暂停其他 Agent 发送，避免并发写入造成额外影响；不以清空历史“解决”这个限制。
- 不要点击 Toast 的 Dismiss 或 Center 的“全部已读”：既有行为会把不相关通知也标为已读。只操作标记的合成行。
- 测试数据保留用于追查，不自动删除或改写原历史。既有配置若禁用通知，检查会失败/未观察，不擅自改设置。
- 重启必须显式许可；检测其他 checkout daemon/tray 或无法辨认其所属时拒绝重启。应用既有 restart 会维护登录启动项，优先用专门账户。
- `acceptance.json` 不导出现有事件正文、窗口标题、进程命令行、IPC 端口/令牌或凭据。合成通知自己的 stdout/stderr 单独留在输出目录，非默认要求上传。
- 脚本有等待超时，不会杀不明进程；最终返回码非 0 表示存在未通过/未执行项，查看 JSON 定位即可。

## 下一步

这里已把能证明的代码缺陷修复并准备好采集。真正剩余依赖是一台能运行该 patched checkout 的交互式 Windows 桌面；不假设 Wabi 当前能控制你的设备。最小交接是完成上述 Windows 运行并提供 `acceptance.json`，之后可以按实际 reason/句柄/父进程证据继续修，不要求重新定义产品，也不把前台限制当作必须绕过的错误。
