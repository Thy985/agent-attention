# agent-attention：第一轮接手评估与 IPC 可靠性修复

日期：2026-10-21。基线提交：`c42a71c605434452b4dcebac61dfa7cd140d70e0`。
工作分支：`wabi/notification-reliability-20261021`。所有改动仅在本地；未 push、未开 PR、未部署或修改外部服务。

## 判断

项目不是空壳，也不适合简单判为“废品”。README 定义的是 Windows 上的 AI Agent 通知基础设施：Agent CLI → Node daemon → Toast、声音、托盘和 C# Center。仓库已有实际状态模型、通知管线、Agent 集成、Windows UI、测试及实机验收记录。

但不能把它当成已经稳定的成品。最先应该兑现的是“Agent 完成/失败/等待人工时，通知准确出现、已读操作生效、重启后状态同步”，不是继续堆功能。本轮保留这个产品意图，不重写成新产品。

## 已发现并本地修复

1. **鉴权前仍能执行 RPC。** 原服务器在拒绝握手后继续进入命令解析；用真实 TCP 连接直接发送无 hello 的 probe 命令，原源码确实调用了一次 handler。现在在每帧处理前检查鉴权，拒绝后不再分发。
2. **未鉴权连接收到广播。** 原代码连接建立即进入广播集合。回归测试在原源码中收到了 registry-changed sentinel。现在只有已鉴权且订阅成功的 socket 才能接收广播。
3. **把 TCP 分块当 JSON 消息。** 原代码按 data 回调 JSON.parse，遇到拆包、粘包或中文 UTF-8 字节分割会丢消息。现在按换行重组帧，处理同一块中的多条消息，并保留 UTF-8 边界；增加 1 MiB 帧限额与握手等待超时。
4. **UI 命令回执读错连接。** 原 SendCommand 新建连接却未鉴权，并把等待回执登记在另一个订阅客户端上。现在在命令连接上发送 hello + cmd，并读取匹配 requestId 的 ack，有可取消的 5 秒超时。
5. **重连、状态变化和生命周期。** 每次 RPC/重连重新读取 token/port；IsConnected 反映订阅连接而非“端口文件存在”；解析 payload.status；state-changed 重新加载状态；Stop 取消阻塞读取。Program 里供 CommandRunner 使用的另一个 IPC client 原本未 Start，现补启动与作用域释放。
6. **托盘快路径与兜底。** IPC worker 回调通过 UI Dispatcher 更新 NotifyIcon/菜单；断连时保留文件轮询，连接时继续生命周期检查；Stop 后忽略已排队回调。这部分已交叉编译，仍需 Windows 桌面验收。
7. legacy pushStateToClients 改为向已订阅 socket 推状态，而非再创建一个未鉴权入站连接。服务器跟踪所有连接，关闭时清理未鉴权连接；同步 handler 异常也返回负 ack。

## 实际验证结果

- TypeScript：`node node_modules/typescript/bin/tsc`，成功。
- 新增真实 TCP 回归 `tests/ipc-stream-regression.test.ts`：**修复前 2 通过 / 7 失败；修复后 9 / 9 通过**。不是只检查源码字符串。覆盖鉴权绕过、拒绝 hello 后的命令、广播隔离、粘包、拆包/中文、超大帧、args 校验、同步异常回执和状态快照广播。
- 新增 .NET 10 harness：直接编译生产 IpcClient、StateStore、Models，以真实 loopback TCP + 模拟 daemon 响应测试：**10 项断言全部通过**。覆盖同连接鉴权/RPC、Unicode、回执匹配、拒绝、状态更新、token/port 轮换重连与停止取消。
- 完整 Windows-target UI 构建：`dotnet build src/center/csharp/AgentAttention.UI/AgentAttention.UI.csproj -c Release -p:EnableWindowsTargeting=true`：**0 warnings、0 errors**。运行主机为 Linux，这不是 Windows UI 实机运行。
- 原有全套 Jest 基线：228 通过 / 13 失败，共 241。最终包含 9 个新用例的全套：**237 通过 / 13 失败，共 250**，23 套通过 / 7 套失败，不能称为“全绿”。最终失败中 10 项要求 Windows IPC（Linux 上产品主动不启动该服务），2 项要求已发布的 Windows UI exe。另 1 项是已有 JS heapUsed 分配阈值测试：本次增量 0.608 MiB 超过其 0.5 MiB 阈值；上一轮相同补丁的全套该项通过。它不读取 C# 托盘代码，不能据此宣称真实 Windows GDI 泄漏已测或已修。基线另有 telemetry reset 路径测试失败，最终此项通过；本轮没有修改 telemetry，不把这一变化计为修复。
- 现有 ipc-security 源码测试更新为检查重连/命令各次读取新 token，去掉旧的“启动缓存一次 token”的预期。其中原有 Windows 运行检查会在无 daemon 时返回并打印 SKIP；不得把这部分当作 Linux 上已完成 Windows 鉴权实测。新 9 项测试不依赖该跳过路径。

## 可复跑命令

```sh
npm ci
npm run build
node node_modules/jest/bin/jest.js tests/ipc-stream-regression.test.ts --runInBand --forceExit
# .NET 10 SDK
dotnet run --project tests/ipc-client-harness/IpcClientHarness.csproj -c Release
# Windows 正常构建；Linux 只可交叉编译
dotnet build src/center/csharp/AgentAttention.UI/AgentAttention.UI.csproj -c Release -p:EnableWindowsTargeting=true
```

本次机器使用独立的 `/tmp/wabi-npm-10` 与 `/tmp/wabi-dotnet-10/dotnet`，因为原机器的 npm 11 启动有问题；没有改变项目依赖声明或锁文件。依赖、构建脚本及测试脚本在运行前已检查。测试 HOME 使用临时目录，未把真实用户通知数据作为测试输入。

## 下一阶段验收与真实边界

现有仓库 `docs/ROADMAP-AND-VERIFICATION-v0.4.md` 的 H2-0 S6 已记录 Windows Target Jump 实机失败：CLI 返回成功但前台窗口未切换，涉及 Windows 前台锁。本轮没有宣称修复这一设计问题。

下一阶段建议固定一个真实 Agent 集成，完成 Windows 桌面闭环：

1. 完成、失败、需要人工三类事件各送一次，核对 Toast、Center 与未读数，不重不漏。
2. 单条/全部已读，检查实际状态文件及 RPC 回执，不只看按钮反应。
3. daemon 重启后端口/token 轮换，UI 自动恢复；断线时文件兜底仍刷新。
4. 检查 UI Dispatcher 路径、退出时无残留进程；长时运行测真实 GDI/USER handle，不以 Node heapUsed 代替。
5. 用真实目标终端窗口测点击回跳；保留失败证据，不能用 CLI 退出码代替前台窗口验证。
6. 在干净 Windows 账户检验 self-contained 包和 doctor；本轮没有发布/安装验证。

当前具体缺口是可交互的 Windows 桌面测试环境，而不是要用户重新描述产品。现有 IPC 补丁与测试不依赖可选偏好，可以先进入审阅。鉴权修复仅收紧本地协议边界，不等于完成 Windows ACL、完整 DoS 或同用户恶意进程安全审计。
