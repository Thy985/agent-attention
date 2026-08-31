# DeepSeek Harness (dsh) 接入机制调研报告

> 日期：2026-08-31
> 调研方式：阅读 dsh 源码 + SKILL.md + README，基于实际 checkout（`D:\DevCaches\npm-global\node_modules\@deepseek-ai\dsh`）

---

## 一、dsh 架构核心：Cordis 插件注册表

```
dsh = Profile Launcher + Cordis Composition Engine
├── Profiles（web / headless / tui）：通过 bundle 组合
├── Bundles：Shipped 包（@deepseek-ai/dsh-base 等）+ 用户插件
├── Cordis 插件（yaml patch）：声明式 compose
│   ├── Host Plane：进程级 Registry（tools / services / events / sessions）
│   └── Agent Preset（per-session scope）：persona / tools / prompt sections
├── 插件入口：cordis.yml（`id` + `name` + `config`）
└── Dynamic Plugin：运行时通过 `cordis_define/run` 创建 JS 模块
```

关键包清单（来自 `package.json` dependencies）：
- `@deepseek-ai/cordis`：内核，`^4.0.1`
- `@deepseek-ai/dsh-base`：Host composition（registries / persistence / sandbox）
- `@deepseek-ai/dsh-headless`：headless profile
- `@deepseek-ai/dsh-web-app`：Web UI profile
- `@deepseek-ai/dsh-tool-cordis`：Cordis 自省工具集（`cordis_inspect/run/stop`）
- `@deepseek-ai/dsh-mcp-client`：MCP server 桥接插件
- `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-skill-filesystem`：SKILL.md registry
- `@deepseek-ai/dsh-persona` / `@deepseek-ai/dsh-agent-instructions`：人格/指令注入

---

## 二、dsh 三大明确支持的接入面

### 2.1 MCP（Model Context Protocol）—— L4 Plugin/MCP

**包**：`@deepseek-ai/dsh-mcp-client`

**接入方式**：在 `cordis.yml` 添加一行 plugin row：

```yaml
- id: mcp-agent-attention
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: attention        # 命名空间
    transport: stdio             # stdio 或 streamable-http
    command: node
    args: ['dist/mcp-server.js'] # Agent Attention 提供的 MCP server
    env:
      AGENT_ATTENTION_STATE_DIR: ~/.agent-attention
```

**效果**：模型通过工具名 `attention__get_events`、`attention__clear_events`、`attention__query_agent` 等访问。命名规范与 Claude Code / Codex 一致（`mcp__<serverName>__<rawName>`）。

**已验证**：
- dsh 本地 headless profile 已预装 `mcp-server-filesystem`（`~/.dsh/profiles/headless/.mcp.json`）
- `README.zh.md` 有中文说明
- HMR 热重载：编辑 `cordis.yml` 不重启进程即生效
- 可配置的 reconnect 策略（initialDelayMs 500ms，翻倍后退避，maxDelayMs 30s，maxAttempts 10）

### 2.2 SKILL.md —— L1 Skill

**包**：`@deepseek-ai/dsh-skill` + `@deepseek-ai/dsh-skill-filesystem`

**接入方式**：在项目根目录放置 `SKILL.md`，dsh 自动发现。

**效果**：
- `ctx.skills` 接口提供 provider 注册和 catalog 查询
- `skill-filesystem` provider 扫描 workspace 根目录下 `SKILL.md` 文件
- 加载后注入 `<skill_content name="...">` 到模型 system prompt
- 触发：用户显式调用 `/skill <name>`，或模型根据上下文自动选择

**标准格式**（SKILL.md frontmatter）：
```markdown
---
name: agent-attention
description: CLI 工具，用于配置和管理 agent 注意力通知
---

Agent Attention 是 Claude Code / DeepSeek 等 agent 的注意力通知中心。
常用命令：
- `agent-attention daemon start` — 启动后台守护进程
- `agent-attention integration list` — 列出已注册 agent
...
```

**事件驱动**：`skills/change` 事件在 provider 注册/销毁后发出（无 diff，消费方需重新 `snapshot()`）。

### 2.3 动态 Cordis Plugin —— L4 Plugin（原生扩展）

**包**：`@deepseek-ai/dsh-tool-cordis`

**工具集**：
- `cordis_inspect_list`：列出 Host/Client 所有 Providers、Methods、Schemas
- `cordis_inspect_query`：精确查询 Service / Event / Tool / Slot / Theme token 的契约
- `cordis_define`：创建 Plugin 的 Package（定义 `code.host` + `code.client`）
- `cordis_run`：激活 Package（sandbox 中评估 JS）
- `cordis_stop` / `cordis_undefine`：停用/删除

**Platform 选择指南**（来自 SKILL.md）：

| 需求 | 首选平台 | 先查 inspect 的什么 |
|------|---------|-------------------|
| Files / commands / processes / networking | Host | `Service.listService`（fs / bash / subprocess / web） |
| Agents / durable Session / Host lifecycle | Host | `Event.listEvents` |
| Register dynamic Tool | Host | `Builtin.listBuiltins` + `Tool.listTools` |
| Page theme / layout / current page state | Client | `Theme.listTokens` + Client `Service.listService` |
| Conversation Snapshot / session / workspace lists | Client | 对应 Slot 的 standard props |
| Settings pages / sidebars / overlays / Tool cards | Client | `Slots.listSubTree` |
| Fetch on Host and display on Client | Both | Host Service + `harness.handle`; Client Slot + `host.call` |

**信任定位**：sandbox 隔离全局但非安全边界；`ctx.fs / ctx.web / ctx.bash` 等 Host helpers 可 escape。等同于 bash access。

---

## 三、dsh 不支持的机制

### 3.1 stdin JSON Hook（L3）—— 不支持

**依据**：
- dsh README / agent.cordis.yml 中零 `hook` / `event` / `lifecycle` / `onExit` / `notify` 关键词（仅 5 处 `exit` 相关，都是进程退出处理）
- 无 stdin JSON 解析、无生命周期回调、无 Agent exit event 推送机制
- Agent Attention 的 `node dist/daemon-cli.js hook '{"sessionId":"...","exitStatus":0,...}'` 在 dsh 下**完全无效**

**原因**：dsh 的 agent-loop 是 Cordis 内部实现，没有暴露 "agent 结束时通知 Runtime" 的钩子点。Claude Code / Cline 的 stdin 管道约定不适用于 dsh。

### 3.2 Wrapper 脚本（L2）—— 不原生支持

**依据**：
- dsh 的 bash/pwsh 工具（`@deepseek-ai/dsh-tool-bash` / `@deepseek-ai/dsh-tool-pwsh`）是普通的 Shell executor
- 不捕获父进程的 stdout 结构化数据（如 "completed / failed / input_required"）
- 无 "wrapper 入口" 约定——Agent 在 dsh 内以 Cordis Plugin 形式运行，不是独立子进程

### 3.3 Agent Identity 声明（`AGENT_ID` 环境变量）—— 不支持

**依据**：
- dsh 内部无 `AGENT_ID` / `AGENT_NAME` 环境变量约定
- `dsh-persona` 包仅注入 persona text 模板，不声明 agent 身份
- Agent 身份由用户运行时决定，与 Runtime 无关

---

## 四、接入等级评估

| 等级 | 含义 | dsh 支持？ | 适用场景 |
|------|------|-----------|---------|
| L0 Manual CLI | 人工调用 CLI | ✅ 当然 | 所有 agent |
| L1 Skill | `SKILL.md` 自动发现 | ✅ 原生 | 快速上手，无代码 |
| L2 Wrapper | wrapper 脚本封装 | ❌ 无约定 | 不适用 |
| L3 Hook/Event | stdin JSON 管道 | ❌ 不支持 | 不适用 |
| L4 Plugin/MCP/ACP/Native | Cordis Plugin / MCP Server | ✅ MCP 原生，Plugin 动态 | 高集成度 |

**推荐优先级**：
1. **L4 MCP Server**（最高集成度，一次实现，dsh/Claude Code/Codex 全平台通用）
2. **L1 SKILL.md**（低成本，快速上手，配合 L4 使用）
3. **L4 动态 Plugin**（调试期 / 运行时扩展，生产用静态 `cordis.yml`）

---

## 五、具体实现路径

### 5.1 MCP Server（推荐首选）

**工具选择**：官方 `@modelcontextprotocol/sdk`（TypeScript）。

**MCP Tools 设计**（与现有 state 对齐）：
```typescript
// attention__get_events
// 参数：{ limit?: number; unreadOnly?: boolean }
// 返回：最近 N 条 attention events（含 type/priority/agent_id/message/read/unreadCount）

// attention__clear_events
// 参数：空
// 返回：操作结果（清空的 event 数）

// attention__agents
// 参数：{ agentId?: string }
// 返回：已注册 agent 列表（id/name/level/reliability）或单个 agent 详情
```

**MCP Transport**：stdio（与 dsh-mcp-client 默认配置一致）

**目录结构**：
```
src/
└── mcp-server.ts      # MCP server 入口
scripts/
└── mcp-server.ts      # 可选：CLI wrapper
```

**package.json 更新**：
```json
{
  "bin": {
    "agent-notify": "./dist/index.js",
    "agent-attention": "./dist/daemon-cli.js",
    "agent-attention-mcp": "./dist/mcp-server.js"   // 新增
  },
  "files": [
    "dist/",
    "src/center/csharp/dist/win-x64/**/*",
    "skills/",
    "scripts/"
  ],
  "dependencies": {
    ...现有...,
    "@modelcontextprotocol/sdk": "^1.0.0"           // 新增
  }
}
```

**dsh 端接入**（用户手动添加到 `~/.dsh/profiles/<profile>/cordis.yml`）：
```yaml
- id: mcp-agent-attention
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: attention
    transport: stdio
    command: node
    args: ['dist/mcp-server.js']
```

### 5.2 SKILL.md（低成本补充）

**位置**：`SKILL.md`（项目根目录，已被 `files` 包含）

**内容**（待后续创建，先占位）：
```markdown
---
name: agent-attention
description: Agent Attention Center v0.2 — 跨 agent 注意力通知中心，Daemon + Tray + Toast + Sound
---

Agent Attention 是一个跨 Agent 的注意力投影层，为 Claude Code、Cline、Codex、OpenCode 等提供统一的通知体验。

## 核心功能
- 后台守护进程（Daemon）持续监听并投影 Agent 注意力事件
- 系统托盘图标 + Windows Toast 通知 + 系统声音
- 多 Agent 去重、优先级、可见性、读/未读状态

## CLI 命令
- `agent-attention daemon start|stop|restart|status` — 守护进程管理
- `agent-attention hook` — Agent hook 端点（Claude Code / Cline）
- `agent-attention notify <type> "<message>"` — 发送注意力事件
- `agent-attention integration list|install|uninstall|status <agent>` — Agent 集成管理
- `agent-attention mark-all-read` — 标记所有事件为已读
- `agent-attention mark-event <event-id>` — 标记单条事件为已读
- `agent-attention doctor` — 系统健康检查

## SKILL 提示
当收到 "completed / failed / thinking / input_required" 事件时，自动在 Agent 会话开始前调用
`agent-attention notify <type> "<message>"` 来投影注意力。
```

### 5.3 dsh Cordis Plugin（可选）

**位置**：`${DSH_HOME:-~/.dsh}/.agent-presets/agent-attention/`

**文件**：
- `preset.yml`：显示名称 + 描述
- `agent.cordis.yml`：挂载 `mcp-agent-attention` plugin row + 可选 persona

**注意**：此方案需用户手动安装到 `~/.dsh`，MCP Server 方案通用性更强。

---

## 六、对比其他 Agent 的接入等级

| Agent | L1 Skill | L2 Wrapper | L3 Hook | L4 Plugin/MCP |
|-------|---------|------------|---------|---------------|
| Claude Code | ✅ | ✅ | ✅（stdin JSON） | ✅（mcp.json） |
| Cline | ✅ | ✅ | ✅（cline hook） | ✅（mcp.json） |
| Codex | ✅ | ✅（wrapper） | ❌ | ❌ |
| OpenCode | ✅ | ❌ | ❌ | ✅（plugin 系统） |
| Aider | ✅ | ✅（wrapper） | ❌ | ❌ |
| Continue | ✅ | ❌ | ❌ | ❌ |
| **DeepSeek Harness** | ✅（dsh-skill-filesystem） | ❌ | ❌ | ✅（`dsh-mcp-client` + 动态 plugin） |

**关键结论**：
- dsh 的 **L4 MCP** 支持与 Claude Code 完全等价（同一个 `mcp-client` 插件）
- dsh 的 **L1 SKILL.md** 与 Claude Code 完全等价（同一个 `dsh-skill-filesystem` 提供者）
- dsh **不支持** L2/L3（无 stdin JSON 钩子、无 wrapper 约定），与预期一致

---

## 七、实现顺序建议

```
Step 1: 实现 MCP Server（src/mcp-server.ts，~150 行）
Step 2: 更新 package.json（bin + dependencies + files）
Step 3: npm install @modelcontextprotocol/sdk
Step 4: npm test + npm run build
Step 5: E2E：在 headless dsh profile 添加 cordis.yml row，验证 attention__get_events
Step 6: 创建 SKILL.md（项目根目录）
Step 7: 更新 docs/dsh-integration-research.md（本轮）+ NEXT_STEPS.md
Step 8: commit + push
```

预计工作量：**1 天**（含测试与 E2E 验证）。
