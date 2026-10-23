# 事件证据契约（首个实现）

本轮推进 #3/#4；没有将协议名称、进程退出或一次模型响应结束当作业务任务验收。

## 已实现的信号映射

参考 `tests/fixtures/claude-hooks/provenance.json` 中固定版本的官方来源：Claude Code hooks 文档与 `@anthropic-ai/claude-agent-sdk@0.3.306` 类型。JSON fixtures 是文档的原样示例，不是用户现场采样；不代表已安装的任意 Claude CLI 版本均已实测。

| 输入 | 输出 | 证据范围 |
|---|---|---|
| `PermissionRequest`（显式送入解析器） | `permission_required` | 工具授权请求，不是授权结果 |
| `Notification` + `permission_prompt` | `permission_required` | 等待授权的提示，不是授权结果 |
| `Elicitation` | `input_required` | MCP 服务器发起的输入请求，不是用户已回答 |
| `StopFailure` | `failed` | 当前响应失败，业务任务最终状态仍未知 |
| `Stop` / `SessionEnd` / `TaskCompleted` / `PostToolUse` | 不生成结果通知 | 响应结束、会话退出、任务账本变动、工具成功均不等于业务验收 |
| 旧自造 `exitStatus`、未知 hook、空/非法 JSON | 不生成通知 | 无受支持证据 |
| wrapper 退出 0 / 130 / 143 | 不生成通知 | 正常退出或信号/取消不等于业务完成或需要输入 |
| wrapper 其他非零合法退出码 | `failed`，明确写进程退出/任务未知 | `process` 范围的观察，不是业务失败判决 |
| 无专用契约的通用 plugin `status=success/completed/error` | 不生成通知 | 工具/协议成功不能冒充任务结果 |
| 用户或 Agent 显式 `agent-notify completed ...` | 保持兼容 | `manual-cli/v1` 的 `explicit_report`，只是发送方声明，不是独立验收 |

`verified` 仅表示上述受支持字段通过契约校验的结构化信号。它不表示独立验证任务成功。L0–L7 数值保留兼容，但不是可靠性排行榜；`getEffectiveReliability()` 只检查 `completed` 对应的映射，不能借用授权请求的可靠性抬高完成评级。没有实现版本化契约的接入保持实验状态，不伪称已实测。

## 保留的数据与隐私

state version 仍为 1，旧事件/已读数据原样兼容，新事件可增加 `session_id`、`task_id`、`source_event_id`、`source_event` 和 `evidence`（契约、机制、依据、范围）。源应用身份来自选中的 manifest，不接受 payload 中伪造的 agent 身份。

不复制 `transcript_path`、cwd、工具参数、请求 schema、URL、错误详情或完整最后回复；通知用固定说明。旧版 state 缺失这些字段时不会被猜测补全。

Claude 请求不一定有稳定的事件 ID。只有源确实提供 `elicitation_id` 时才用于投递重试去重；无 ID 不按正文合并，宁可保留两个真实请求。状态中的投递去重键包含来源、会话、任务、源事件与契约，同一次已读事件的重试不会重新变成未读。当前保留窗口仍为最多 20 条，超出窗口后不保证跨窗口幂等；未改变存储/并发写入模型。

显式 CLI 可用以下可选环境变量传递真实身份：

```
AGENT_ID=<agent>
AGENT_ATTENTION_SESSION_ID=<source session>
AGENT_ATTENTION_TASK_ID=<source task>
AGENT_ATTENTION_EVENT_ID=<stable delivery id>
```

不能获得的 ID 留空，不能从正文/机器主机名猜测。原有 CLI 的短时间重复抑制仍兼容，但会话/任务/Agent 不同不会仅因正文相同而互相覆盖。

## 安装入口与边界

先构建 `node node_modules/typescript/bin/tsc`，再运行：

```
node dist/daemon-cli.js setup hook --project <directory>
node dist/daemon-cli.js setup hook --project <directory> --verify
```

`integration install claude-code` 与兼容的 `dist/scripts/install-hook.js` 也复用同一安装器，写入原生 `.claude/settings.json`，不再写无效的 `hooks.json`。只替换本工具的命令，保留其他设置、其他命令（包括同组命令）；无效 JSON 拒绝覆盖。旧 `hooks.json` 不会被自动删除。卸载仅清理所选 settings 文件中的本工具命令。

默认注册 `Notification(permission_prompt)`、`Elicitation`、`StopFailure`，并保留旧 `SessionStart`/`Stop` 为兼容无操作观察。解析器支持 `PermissionRequest`，但默认不注册这个可影响授权交互的拦截点；不输出 allow/deny 或输入回应。没有自动批准、修改或取消 Agent 请求的行为。

安装目标 Claude 版本需要支持这些 hook；本轮未运行真实 Claude 登录会话。若运行版本不支持，先按其官方版本文档调整配置，不因配置存在就声称接入健康。

## 可复现检查

依赖已安装且 .NET 10 SDK 位于 PATH 时：

```
node scripts/verify-core-baseline.mjs
```

此 gate 运行 TypeScript 编译、真实 TCP 流回归、窗口跳转返回契约测试（Windows API mock，不是桌面激活）、真实文档 fixtures、hook 子进程、状态与去重测试，以及直接链接生产 C# IPC/StateStore 代码的环回 TCP harness。无 .NET 时明确失败，不把缺依赖当通过；测试在临时 `AGENT_ATTENTION_HOME` 下运行。

全套 Jest 仍单独运行并报告，不通过选择性 gate 掩盖 Windows 服务/安装后 EXE 依赖。真实 Windows Toast、WPF/托盘、已读、焦点回跳与重启恢复仍须运行 `docs/TARGET-JUMP-WINDOWS-ACCEPTANCE-2026-10-21.md` 的实机验收流程。

## 尚未完成

- 未做 UI 新字段展示/筛选，不将其算作 #4 全部完成。
- 未做任意 provider 的真实业务成功验收或其他 Agent 版本契约。
- 未完成 Windows 桌面验收、安装包门槛或 Linux 真实桌面后端。
- 未 push、PR、评论/关闭议题或发布。补丁是三轮工作的合并交付，不是安装包。
