# Agent Attention Center v0.1 MVP 需求文档

**版本**：v0.2
**状态**：TeamMind Runtime 集成设计
**目标平台**：Windows
**产品形态**：TeamMind Runtime Attention Layer
**核心目标**：用最低实现成本验证“统一 Agent 注意力通知”这一核心需求。

------

## 1. 产品概述

Agent Attention Center 是一个面向 AI Agent 用户的轻量级本地通知基础设施。

它解决的问题不是“Agent 没有通知 API”，而是：

> 用户离开 Agent 当前窗口去做其他事情后，不知道 Agent 何时完成、失败、等待输入或需要授权。

v0.1 不追求完整的 Agent 聚合中心，而是首先建立最短可用链路：

```text
AI Agent
   ↓
Agent Attention Skill
   ↓
agent-notify CLI
   ↓
Windows 系统通知
   ↓
声音提醒
```

用户无需持续查看 Terminal / IDE，只在真正需要注意时返回 Agent。

------

## 2. MVP 核心目标

v0.1 只验证三个核心假设：

### H1：Agent 用户确实需要离开当前 Agent 界面

用户可以在 Agent 工作期间：

- 浏览网页
- 阅读论文
- 编写其他代码
- 使用其他软件

而不需要持续观察 Agent。

### H2：少量关键事件足以产生明显价值

第一版只关注四类事件：

```text
completed
permission_required
input_required
failed
```

不处理完整进度流。

### H3：系统级通知能够显著降低注意力消耗

用户能够通过：

```text
声音
+
Windows Toast
```

知道“有事情需要处理”。

------

# 3. 非目标

v0.1 明确不做以下内容：

- 不做完整桌面 GUI
- 不做 Agent Attention Center 面板
- 不做多 Agent 聚合
- 不做 MCP Server
- 不做 ACP 集成
- 不做云服务
- 不做手机推送
- 不做 Windows/macOS/Linux 跨平台
- 不做自动发现 Agent
- 不做复杂通知策略
- 不做 Agent 状态持久化
- 不做权限管理系统
- 不做任务调度

这些属于后续版本。

------

# 4. 用户场景

## 4.1 任务完成

用户启动：

```text
Claude Code
```

然后离开 Terminal。

Agent 完成后执行：

```text
agent-notify completed "Claude Code 任务已完成"
```

系统：

```text
Windows Toast
+
提示音
```

用户返回查看结果。

------

## 4.2 等待用户授权

Agent 执行高风险操作：

```text
Codex
需要用户授权执行 git push
```

Skill 调用：

```text
agent-notify permission_required "Codex 等待你的授权：执行 git push"
```

系统立即提醒。

这是最高优先级事件。

------

## 4.3 等待用户输入

Agent 停止执行：

```text
Claude Code
waiting for input
```

系统：

```text
声音
+
Toast
```

用户返回 Terminal。

------

## 4.4 Agent 失败

Agent 执行测试失败：

```text
agent-notify failed "Codex 测试失败：17 tests failed"
```

系统通知用户。

------

# 5. 产品核心原则

## 5.1 不打断用户

系统通知应该让用户知道：

> “有 Agent 需要你的注意。”

而不是迫使用户立刻切换窗口。

因此通知默认：

- 不抢焦点
- 不自动打开 Terminal
- 不自动执行任何操作

只有用户主动点击，才进入对应 Agent。

------

## 5.2 声音优先于视觉

用户可能正在：

- 浏览器
- VS Code
- PDF
- 全屏应用

因此系统必须支持声音提示。

v0.1 至少提供：

```text
permission_required → 明显提示音
input_required      → 明显提示音
failed              → 明显提示音
completed           → 普通提示音
```

------

## 5.3 Agent 不应该依赖模型“记住通知”

Skill 是第一版入口，但架构必须为后续 Hook / ACP / MCP 接入预留空间。

因此通知 CLI 必须设计成独立组件：

```text
Agent / Skill / Hook / ACP / MCP
              ↓
        agent-notify
              ↓
      Notification Backend
```

而不能把逻辑全部写死在 Skill 中。

------

# 6. 系统架构

```text
┌──────────────────────┐
│      AI Agent        │
│ Claude / Codex / Qwen│
└──────────┬───────────┘
           │
           │ Skill
           ▼
┌──────────────────────┐
│ Agent Attention Skill│
│                      │
│ Event detection      │
│ Notification rules   │
└──────────┬───────────┘
           │
           │ CLI
           ▼
┌──────────────────────┐
│   agent-notify CLI   │
│                      │
│ Parse arguments      │
│ Validate event       │
│ Select priority      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Notification Backend │
│                      │
│ Windows Toast        │
│ Sound                │
└──────────────────────┘
```

------

# 7. Skill 需求

Skill 名称暂定：

```text
agent-attention
```

其职责是向 Agent 明确规定：

### 必须通知的事件

```text
1. 任务完成
2. 任务失败
3. 需要用户授权
4. 需要用户输入
```

### 不需要通知的事件

```text
1. 普通工具调用
2. 普通思考
3. 普通文件修改
4. 普通测试运行
5. 普通进度变化
```

### 通知原则

只有满足“用户需要重新关注 Agent”的条件才发送通知。

------

# 8. CLI 需求

命令：

```bash
agent-notify
```

### 基础调用

```bash
agent-notify completed "任务已完成"
agent-notify permission_required "需要你的授权"
agent-notify input_required "等待你的输入"
agent-notify failed "任务执行失败"
```

------

# 9. CLI 参数

最低版本支持：

```text
agent-notify <event> <message>
```

其中：

### event

```text
completed
permission_required
input_required
failed
```

### message

任意 UTF-8 文本。

例如：

```bash
agent-notify permission_required "Codex 请求执行 git push"
```

------

# 10. 优先级

事件默认映射：

| Event               | Priority |
| ------------------- | -------- |
| permission_required | P0       |
| input_required      | P0       |
| failed              | P1       |
| completed           | P2       |

v0.1 不允许用户自定义优先级。

------

# 11. Windows Notification

系统必须调用 Windows 原生 Toast Notification。

Toast 至少包含：

```text
Title
Message
```

例如：

```text
Codex
需要你的授权：执行 git push
```

------

# 12. Sound

每次有效通知允许播放声音。

不同事件允许采用不同音效，但 v0.1 不要求自定义音频。

最低要求：

```text
permission_required → audible
input_required      → audible
failed              → audible
completed           → audible
```

用户未来可以配置：

```text
声音开关
音量
不同事件不同声音
```

但不属于 v0.1。

------

# 13. 防刷屏

v0.1 只实现最简单的去重：

同一 Agent、同一 event、同一 message 在短时间内重复发送时，不重复弹出。

例如：

```text
permission_required
"需要你的授权"
```

连续发送 5 次：

```text
只通知一次
```

v0.1 不做复杂聚合。

------

# 14. 错误处理

如果 Notification Backend 失败：

```text
CLI 返回非零 exit code
```

但不能导致 Agent 本身失败。

例如：

```text
Agent
  ↓
agent-notify
  ↓
Windows Toast failure
```

不应该变成：

```text
Agent task failed
```

通知系统必须属于：

> **best-effort infrastructure**

即：

> 通知失败不能影响 Agent 主任务。

------

# 15. 配置文件

v0.1 可以提供简单配置：

```yaml
enabled: true

sound:
  enabled: true

events:
  completed: true
  permission_required: true
  input_required: true
  failed: true
```

默认值：

```text
enabled = true
sound.enabled = true
all events = true
```

不需要复杂配置系统。

------

# 16. 安装方式

目标是：

```bash
npm install -g agent-attention
```

或者：

```bash
pip install agent-attention
```

具体语言在实现阶段确定。

安装后：

```bash
agent-notify completed "Hello"
```

即可测试。

------

# 17. 最小验证标准

安装成功后，执行：

```bash
agent-notify completed "Agent Attention Test"
```

必须出现：

```text
Windows Toast
+
声音
```

执行：

```bash
agent-notify permission_required "Permission required"
```

必须出现更明显的通知。

------

# 18. Skill 验证

将 Skill 接入 Claude Code / Codex / Qwen Code 中至少一个 Agent。

用户启动：

```text
一个持续运行 > 30 秒的任务
```

然后切换到其他应用。

任务完成后：

```text
用户无需查看 Agent 窗口
↓
收到声音
↓
看到系统 Toast
↓
知道 Agent 已完成
```

这构成 MVP 的核心验收。

------

# 19. MVP 验收标准

## A. 安装

-  Windows 安装成功
-  `agent-notify` 命令可执行
-  无需额外服务器
-  无需登录账号

## B. 通知

-  completed 可以通知
-  permission_required 可以通知
-  input_required 可以通知
-  failed 可以通知
-  Toast 正常显示
-  声音正常播放

## C. 稳定性

-  通知失败不会影响 Agent
-  重复通知不会无限刷屏
-  中文消息正常显示
-  特殊字符不会破坏 CLI

## D. Agent 集成

-  至少一个 Agent 能通过 Skill 触发通知
-  用户离开 Agent 后仍然能够收到通知

------

# 20. 后续版本路线

v0.1：

```text
Skill
+
CLI
+
Windows Toast
+
Sound
```

v0.2：

```text
State 持久化
+
Tray Icon
+
Mini Panel（右键菜单）
```

详细架构见 `docs/v0.2-architecture.md`。本版本基于"极小三层"原则，放弃 v0.2 早期版本中考虑的 TeamMind Runtime 集成、Hook、事件统一模型等过度设计。TeamMind 接入方式与 Claude Code / Codex / Qwen 完全相同：直接调用 `agent-notify` CLI。

v0.3：

```text
Agent Attention Center
+
Tray
+
事件列表
+
点击跳回 Agent
```

v0.4：

```text
ACP
+
MCP
+
Webhook
+
OpenClaw
```

v0.5：

```text
Attention Engine
+
Priority
+
Dedup
+
Batching
+
Quiet Hours
+
Focus Awareness
```

v1.0：

```text
             Agent Attention Center

Codex       🔴 permission required
Claude      🟡 waiting for input
Qwen        🟢 completed
Cursor      🟢 completed
OpenClaw    🔵 subagent finished
```

并支持：

```text
点击 Agent
    ↓
精确跳转对应 Terminal / IDE / Desktop App
```

------

# 21. 产品边界

Agent Attention Center 不负责：

```text
Agent orchestration
Agent execution
Agent permission management
Agent memory
Agent context
Agent scheduling
```

它只负责：

> **将 Agent Runtime 事件转化为人类可感知、低打扰、可操作的 Attention Signal。**

------

# 22. 核心产品定义

**Agent Attention Center**

> 一个系统级 Agent 注意力基础设施。

核心价值：

```text
让 Agent 在后台工作，
让用户继续做自己的事情，
只有真正需要用户介入时，
才主动占用用户的注意力。
```

v0.1 的成功标准不是“做出一个漂亮的通知工具”，而是验证：

> **用户是否愿意因为这个工具而不再频繁检查 Agent 窗口。**
---

## v0.2 变更：TeamMind Runtime 集成

### 核心架构转变

v0.2 不再是独立的通知工具，而是 **TeamMind Runtime 的人类注意力投影层**。

```
TeamMind Runtime (已有)
      │
      ▼ RuntimeEvent (50+ types)
┌─────────────────────────┐
│ EventAdapter (新)         │  ← 50+ RuntimeEvent → 6 AttentionType
│   不关心的事件 → null      │
└──────────┬──────────────┘
           │ MappedEvent
           ▼
┌─────────────────────────┐
│ AttentionPolicy (新)      │  ← 15 条规则引擎
│   P0/P1/P2 分级           │    permission → P0 notify
└──────────┬──────────────┘    completed → P1 notify
           │ AttentionSignal    progress → silent
           ▼
┌─────────────────────────┐
│ AttentionProjection (新)  │  ← 聚合/去重/批处理
│   aggregate/dedup/batch   │    "3 completed" → 一条
└──────────┬──────────────┘
           │ AttentionNotification
           ▼
┌─────────────────────────┐
│ NotificationSink (新)     │  ← 复用 v0.1 Toast + Sound
│   Toast + Sound + Tray    │
└─────────────────────────┘
```

### 复用清单

| 组件 | 来源 | 状态 |
|------|------|------|
| RuntimeEvent (50+ types) | TeamMind EventType.java | 复用 |
| AgentInvocation 状态 | TeamMind runtime | 复用 |
| Toast + Sound | v0.1 notification/win32.ts | 复用 |
| Dedup 逻辑 | v0.1 dedup/index.ts | 扩展 |
| Config | v0.1 config/index.ts | 扩展 |
| CLI 入口 | v0.1 agent-notify | 保留 |

### 新增组件

| 组件 | 文件 | 职责 |
|------|------|------|
| EventAdapter | src/teammind/EventAdapter.ts | TeamMind EventType → AttentionType 映射 |
| AttentionPolicy | src/teammind/AttentionPolicy.ts | 15 条规则引擎，判断 notify/silent/aggregate |
| AttentionProjection | src/teammind/AttentionProjection.ts | 聚合/去重/批处理/上下文抑制 |
| NotificationSink | src/teammind/NotificationSink.ts | Toast + Sound 投递 |
| AttentionPipeline | src/teammind/AttentionPipeline.ts | 编排器：Event → Policy → Projection → Sink |

### 测试

- **62 tests pass, 0 failures**
- 覆盖：EventAdapter、AttentionPolicy、AttentionProjection、AttentionPipeline

### 战略优势

> 不是"我能弹 Windows Toast"，而是：
> **"我理解整个 Agent Team Runtime，所以我知道什么时候一个事件真的值得占用人类注意力。"**

- task.completed + 无阻塞 → 静默
- task.completed + 阻塞下游 → 通知
- subagent.completed + Lead 运行中 → 静默
- permission_required → P0 立即通知
- 普通 notification app 无法复制此能力
