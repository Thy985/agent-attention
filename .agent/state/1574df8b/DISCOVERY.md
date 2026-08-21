# S-1 Project Discovery

> 任何 Agent 进入任何代码库，必须先产出本文件，再进入 S-1 后续步骤。
> 这是把方法论 `Router / Adapter` 从散文层落地为 schema 的最小事实源。
> 后续路由决策（flow / gates / roles）以本文档为唯一事实源；本文档变更须留版本。

---

## 0. Meta

```yaml
schema_version: 1
discovery_id: 20260818-192413-1574df8b
generated_by: onboard-command
generated_at: 2026-08-18T19:24:13.006835
project: D:\Projects\Active\agent-attention
harness: claude-code
```

## 1. Repository Snapshot

由命令自动填，禁止手编：

```yaml
language_primary: typescript
framework: node-cli
package_files:
  - package.json          # 待创建
entry_points:
  - src/index.ts          # 待创建（CLI 入口）
  - skills/agent-attention/skill.md  # 待创建（Skill 定义）
existing_agent_config:
  - (see below)
governing_protocol_present: partial   # 用户全局 CLAUDE.md 存在，但项目内无本地配置
harness_adapter_target: CLAUDE.md    # 复用全局 CLAUDE.md；本项目不另写本地 CLAUDE.md
```

**已有文件**：`PRD.md`（需求冻结候选）

**Node 环境**：mise 管理，已安装 Node v22.23.2 / npm 10.9.8

## 2. Layer Inference

由命令扫描后填，禁止手编：

```yaml
layers:
  - name: cli
    path: src/
    role: core
    depends_on: [notification-backend]
  - name: notification-backend
    path: src/notification/
    role: output
    depends_on: []
  - name: dedup
    path: src/dedup/
    role: detection
    depends_on: []
  - name: config
    path: src/config/
    role: ingestion
    depends_on: []
  - name: skill
    path: skills/agent-attention/
    role: domain
    depends_on: [cli]
test_dirs:
  - tests/
doc_dirs:
  - docs/        # 待创建
adr_dirs:
  - ADR/         # 待创建
adr_count: 0
adr_latest: none
```

## 3. Governance Surface (现状盘点)

```yaml
documents_present:
  AGENTS_md: no
  CLAUDE_md: no            # 项目内无本地 CLAUDE.md，依赖全局 ~/.claude/CLAUDE.md
  PERMISSION_matrix: none
  STOP_conditions: none
  ADR_set: 0
  phase_contracts: 0
  verification_reports: 0
  workbuddy_memory_days: 0
ci:
  surface: none
  workflows: []
  pre_commit_hook: no
  pre_push_hook: no
```

## 4. Risk Baseline

```yaml
production_repo: no
multi_collaborator: no
multi_agent: no
irreversible_resources: none
blast_radius:
  blast_radius_score: low
  rationale: 纯本地 CLI 工具，无网络调用、无持久化状态、无破坏性操作，失败影响仅限本机通知
baseline_risk: low
```

## 5. Adapter Decision

把方法论 §4 Harness Adapter 强制落成结构体：

```yaml
adapter_decision:
  primary_passport: CLAUDE.md       # 复用全局 ~/.claude/CLAUDE.md
  secondary_passport: AGENTS.md     # N/A
  write_strategy: skip-local-claude # 不生成项目级 CLAUDE.md，遵循全局规范即可
  deletion_allowed: []
```

> **说明**：本项目为新 MVP，不需要本地 CLAUDE.md。所有工程规范（Git/CI/Debugging）由全局 `~/.claude/CLAUDE.md` 统一约束。

## 6. Open Questions

Router 启动前的人类最终澄清清单（不是技术点，而是 phase 合同前必须问清楚的）：

```yaml
questions:
  - id: Q1
    text: 包名使用 agent-attention 还是 agent-notify？PRD 同时出现两者
    blocking: yes
    owner: human
  - id: Q2
    text: Skill 输出格式（Markdown / JSON / 纯文本）用于触发 CLI，需确认
    blocking: no
    owner: human
  - id: Q3
    text: 声音采用系统 Beep 还是播放 wav/mp3 文件？
    blocking: no
    owner: human
fallback_if_no_human:
  apply_minimal_flow: true
  default_package_name: agent-notify
  default_sound: system-beep
  default_skill_format: markdown
```

## 7. Provenance

```yaml
produced_by: /onboard
inputs:
  - PRD.md 读取完成（Agent Attention Center v0.1 MVP）
  - select_flow.py 执行完成（Flow=Minimal, Gates: G_ci+G_stop required）
checksums:
  repo_top_level_sha256: pending   # git init 后填入