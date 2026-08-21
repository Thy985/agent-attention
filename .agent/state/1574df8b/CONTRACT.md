# Task Contract (S-spec Sync)

> 由 Router 同步触发生成；Human-in-the-Loop ≥medium 必须审批。
> 本文件是 Execution Layer 与 Verification Report 之间的法律合同。

---

## 0. Meta

```yaml
schema_version: 1
contract_id: 20260818-192413-contract
task_id: 1574df8b
router_ref: 20260818-192413-router
approved_by: human
```

## 1. 4W (What / How / Feedback / Done)

对应方法论 §2 Step4 "TaskContract + 四问"：

```yaml
what_changes:
  files:
    - package.json              # npm 项目初始化
    - tsconfig.json             # TypeScript 配置
    - .gitignore
    - src/index.ts              # CLI 入口（yargs 参数解析）
    - src/events.ts             # 事件类型定义 + 优先级映射
    - src/notification/win32.ts # Windows Toast 发送（node-notifier）
    - src/notification/sound.ts # 声音播放（Beep / play-sound）
    - src/dedup/index.ts        # 简单去重（Map<key, timestamp>, TTL 30s）
    - src/config/index.ts       # YAML 配置读取（~/.agent-attention/config.yaml）
    - skills/agent-attention/skill.md  # Agent Skill 定义
    - README.md                 # 安装与使用说明
  rationale: >
    MVP 只验证最短可用链路：Agent → Skill → CLI → Windows Toast+Sound。
    架构预留 Hook/MCP/ACP 接入点（CLI 独立于 Skill）。

how_to_verify:
  tests:
    - npm test                  # jest 单元测试（events 映射、dedup 逻辑、config 解析）
    - npm run build             # TypeScript 编译通过
  manual_steps:
    - npm install -g .
    - agent-notify completed "Agent Attention Test"   # 必须出现 Toast + 声音
    - agent-notify permission_required "Permission required"  # 必须出现更明显通知
    - agent-notify failed "17 tests failed"           # 中文消息正常
    - agent-notify input_required "等待输入"           # 四次调用均正常
    - 连续 5 次相同调用 → 只出现一次 Toast（去重验证）
    - 断开网络（模拟 backend 失败）→ CLI 返回非零退出码，不崩溃
feedback_signals:
  success_metrics:
    - 四次事件均成功弹出 Toast
    - 声音在 Windows 系统音量开启时 audible
    - 去重窗口 30s 内重复调用只通知一次
    - 中文/特殊字符 Toast 不乱码
  failure_metrics:
    - Toast 不弹出
    - 声音无声（系统静音除外）
    - 去重失效（连续 5 次弹出 5 次）
    - CLI 崩溃导致 Agent 主任务中断
done_when:
  - npm install -g 成功后，agent-notify completed "Test" 触发 Windows Toast + 声音
  - 4 种事件（completed/permission_required/input_required/failed）均验证通过
  - 去重机制验证通过
  - 至少接入 1 个 Agent（Claude Code）验证完整链路
  - README.md 安装说明可照做复现
```

## 2. Phase Alignment

```yaml
phase: v0.1-mvp
in_roadmap: yes
adr_required: no
adr_ref: none
```

## 3. Risk

```yaml
risk_score: low
blast_radius: 纯本地 CLI，无网络、无持久化、无破坏性操作
reversible: yes
```

## 4. Approvals

```yaml
approvals:
  - role: developer
    status: approved
    note: "Q1 确认：包名 agent-attention，CLI 命令 agent-notify；Q2/Q3 按 fallback 默认执行"
```
