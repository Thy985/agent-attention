---
name: agent-attention
description: Agent Attention Center v0.2 — 跨 agent 注意力通知中心，Daemon + Tray + Toast + Sound。支持 Claude Code、Cline、Codex、OpenCode、Aider、Continue 接入。
---

# Agent Attention Center

Agent Attention 是一个跨 Agent 的注意力投影层，为 Claude Code、DeepSeek Harness 等运行时的 agent 提供统一的通知体验（Toast + Sound + Tray + Center Window）。

## 核心概念

- **Canonical Attention Events**：`completed` / `failed` / `input_required` / `permission_required`
- **Agent Identity**：由 Agent 声明（`AGENT_ID` env），不推断
- **Integration Level**：L1 Skill → L3 Hook → L4 Plugin/MCP，逐步升级
- **CompletionReliability**：`best_effort` / `probable` / `verified`

## CLI 命令

### Daemon 管理
```bash
agent-attention daemon start          # 启动后台守护进程（Windows tray + toast）
agent-attention daemon stop           # 优雅停止（SIGTERM → 5s 等待 → SIGKILL）
agent-attention daemon restart        # 先等旧 daemon 退出再启动（P3-9 修复）
agent-attention daemon status         # 显示 PID / Tray / State 健康状态
agent-attention daemon wipe           # 清除所有日志
```

### 事件通知（L0-L2 通用入口）
```bash
agent-attention notify <type> "<message>"
# 示例：agent-attention notify completed "Task finished"
#      agent-attention notify input_required "Need user input"
```

### Agent Hook（L3，Claude Code / Cline）
```bash
# 由 Agent 在 session 结束时管道发送 JSON：
echo '{"sessionId":"xxx","exitStatus":0,"turns":5}' | agent-attention hook
# exitStatus: 0=completed 1=failed 2=input_required
```

### Agent 集成管理（L1-L4）
```bash
agent-attention integration list                              # 列出已注册 agent
agent-attention integration status <agent-id>                # 显示 level / reliability
agent-attention integration install <agent-id>               # 从 scripts/integrations/*.json 安装
agent-attention integration uninstall <agent-id>             # 移除 agent manifest

agent-attention agent register <id> "<name>"                 # 注册 agent 身份
agent-attention agent list                                    # 列出已注册 agent
```

### 事件操作
```bash
agent-attention mark-all-read                                 # 标记所有事件为已读
agent-attention mark-event <event-id>                        # 标记单条事件为已读
agent-attention jump <event-id>                              # 打开 Center 窗口并定位到该事件
```

### 诊断
```bash
agent-attention doctor                                        # 系统健康检查（Daemon/Sound/Toast/Tray）
```

## DSH（DeepSeek Harness）接入

### L4 MCP（推荐）
在 `~/.dsh/profiles/<profile>/cordis.yml` 添加：
```yaml
- id: mcp-agent-attention
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: attention
    transport: stdio
    command: node
    args: ['dist/mcp-server.js']
    env:
      AGENT_ATTENTION_STATE_DIR: ~/.agent-attention
```

可用工具：
- `attention__get_events` — 列出最近 N 条注意力事件（支持 `limit`/`unreadOnly`/`agentId` 过滤）
- `attention__clear_events` — 标记所有事件为已读
- `attention__agents` — 列出已注册 agent（支持 `agentId` 过滤）
- `attention__state` — 诊断：返回完整 raw state

### L1 SKILL（自动发现）
本仓库根目录的 `SKILL.md` 会被 `dsh-skill-filesystem` 自动发现，在模型 system prompt 中注入 Agent Attention 的 CLI 用法摘要。

### 不适用
- **L3 stdin Hook**：dsh 没有 Agent exit 生命周期事件推送机制，Claude Code/Cline 的 stdin JSON 管道在 dsh 下无效。
- **L2 Wrapper**：dsh 的 bash/pwsh 工具不捕获父进程结构化 stdout，无 wrapper 入口约定。

## 集成等级参考

| Level | 机制 | Agent 要求 | 可靠性 |
|-------|------|-----------|--------|
| L0 | Manual CLI | 无 | best_effort |
| L1 | Skill（SKILL.md） | Agent 读 Skill 后主动调用 notify | best_effort |
| L2 | Wrapper | Agent 调用 wrapper 脚本 | probable |
| L3 | Hook（stdin JSON） | Agent 退出时管道发送事件 | verified |
| L4 | Plugin/MCP/ACP | Agent 注册到 Runtime registry | verified |

## 验证标准

- `npm test` 208/208 PASS（26 suites）
- `npm run build` 干净编译
- 实机 E2E：toast 按钮回调触发 mark-all-read（ unreadCount 1→0 ）、Center 窗口通过 `-OpenCenter` 启动
- Discord 风格日志：`[timestamp][component][level] event: message`
