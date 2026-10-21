# 候选包与 CI 验收门槛（#7）

这些门槛区分「源码构建」「打包后可运行」「桌面实际好用」。工作流文件存在，不等于远程 CI 已执行；Linux 交叉编译，不等于 Windows 安装或桌面验收通过。

## 固定开发工具链

- Node 24.20.0（`.node-version`），npm 10.9.4（`packageManager`）。运行时 `engines` 仍沿用 >=18，但本轮仅验证 Node 24.20.0，不宣称其他版本已验收。
- .NET SDK 10.0.402（`global.json`；无隐式升级）。Linux 上的 UI 编译仍须 `-p:EnableWindowsTargeting=true`，不能运行 WPF。
- `npm ci --ignore-scripts --no-audit --no-fund`，再 `npm run verify:ci`。关闭安装生命周期只是避免安装时执行源项目 prepare；后续步骤会显式编译，真实 `npm pack` 的 prepare 也会执行，不跳过构建。
- Jest 29 的 Babel peer 要求 Babel 7；开发依赖及 lockfile 已恢复匹配。不得用 `--legacy-peer-deps` 掩盖冲突。

## 分层自动检查

`.github/workflows/verify.yml` 定义 Ubuntu 24.04 与 Windows 2025 两条验证，不包含 publish、push 或部署步骤。

1. TypeScript 编译与直接链接生产代码的 C# IPC harness。
2. Linux 执行所有可运行 Jest 检查；只按确切测试名称分流两项「真实 Windows UI EXE 存在」断言，仍执行同文件的源码和负向路径测试。报告明确记为未运行，而不是通过。Windows lane 先 publish UI，再执行完整 Jest 与 WPF 交互 harness；Linux 专有测试按现有平台声明分流。
3. `npm run verify:package` 真正 `npm pack`、安装到仓库外含空格的临时目录，使用独立状态目录验证：
   - 三个 bin 入口、生成的启动器、MCP shebang；
   - adapter/integration JSON 和 skill 资源完整性；
   - 安装包本身加载资源，CLI 写入/查询事件；
   - 真实 MCP stdio 握手、工具列表、读取和已读；
   - Linux 后台启动、重启、已读恢复和停止。
4. Windows 包另检查发布产物及安装后 UI 解析路径。这只证明包内资源存在，不证明通知或焦点切换成功。

`AGENT_ATTENTION_CI_OUT` 可指定报告目录，默认 `artifacts/ci`。设置 `AGENT_ATTENTION_PACKAGE_OUT` 可保存被测 `.tgz`；`AGENT_ATTENTION_PACKAGE_REPORT` 可指定包报告。报告记录每层通过/失败/未运行，任一实际执行的步骤失败都会使进程失败。不要通过改测试预期或删除测试得到绿色。

## 本地 npm 候选包的用法

交付 `.tgz` 是 Linux headless npm 候选包，不是 Windows/Linux 桌面安装器。需要 Node/npm 与可用的依赖下载网络。依赖版本范围不等于离线、可重现供应链快照；正式发布仍需审计和平台验证。包版本仍为仓库原有 0.2.0，没有冒充新发布版本。

```sh
mkdir -p /tmp/aa-local-candidate && cd /tmp/aa-local-candidate
npm init -y
npm install --ignore-scripts /absolute/path/agent-attention-0.2.0.tgz
export AGENT_ATTENTION_HOME="$(mktemp -d /tmp/aa-state.XXXXXX)"
export AGENT_ATTENTION_MODE=headless
export AGENT_ID=demo-agent
./node_modules/.bin/agent-attention daemon start --headless
./node_modules/.bin/agent-notify completed 'Explicit task completion report'
./node_modules/.bin/agent-attention events
./node_modules/.bin/agent-attention mark-all-read
./node_modules/.bin/agent-attention daemon restart
./node_modules/.bin/agent-attention events
./node_modules/.bin/agent-attention daemon stop
```

MCP 使用安装目录的 `node_modules/.bin/agent-attention-mcp`（或 `node /absolute/path/node_modules/agent-attention/dist/mcp-server.js`），并给它相同的 `AGENT_ATTENTION_HOME` / `AGENT_ATTENTION_MODE=headless`。不要将 MCP stdout 的协议输出当普通日志。

## Windows 与桌面发布仍阻塞的门槛

- 在真实 Windows runner 执行 `npm run verify:ci -- --windows`，保留完整失败报告；当前本地 Linux 工作不代替它。
- 用真实交付布局验证 UI、.NET 自包含运行时与 CLI 路径，不允许靠开发目录恰好存在的 exe 通过。
- 在普通用户 Windows 桌面安装/卸载/升级后，按 `scripts/verify-target-jump-e2e.ps1` 完成通知、Center、已读、回跳失败反馈与重启恢复；保留 `acceptance.json`。不要静默安装启动项，也不要绕过系统焦点限制。
- Linux 有桌面时要另验证桌面能力；无桌面时返回 unsupported 不是弹窗成功。
- 真实 Claude 授权/输入/失败事件须在授权会话验收；fixture 与 SDK 类型测试不代替真实会话。
- UI/UX 仍需独立产品验收。本轮只解决打包/自动检查，不是界面重设计。

目前仍保留历史 20 条上限，未保证 exactly-once、网络文件系统锁、PID 复用或断电 fsync 安全。不得据此关闭所有路线图议题或宣布产品完成。
