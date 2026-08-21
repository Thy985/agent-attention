# Router Output · Adaptive Workflow Selection

> 本文件由 Router（`select_flow.py` 或 `select_flow.md` 引导的人工决策）产出，
> 是 Discovery 之后唯一权威的 flow / gates / roles 决策。
> Execution Layer（Agent / 人类）必须按本文件执行；偏离须显式记录在 `task-state/checkpoint.md`。

---

## 0. Meta

```yaml
schema_version: 1
router_id: 20260818-192413-router
based_on_discovery: 20260818-192413-1574df8b
decided_by: select_flow.py
decided_at: 2026-08-18T19:24:13.007847
```

## 1. Flow Selection

方法论 §3 表格的强制结构体版：

```yaml
flow:
  name: Minimal
  rationale: 新 MVP 项目，无生产仓库、无 CI、无多协作者，仅需单次实现验证核心假设
  skill_pipeline:
    - 编码前四问与PR自检.md        # 实现前自检
    - 原子提交与代码审查.md        # Git 工作流
gates:
  G_ci: required                  # 虽然无 CI，build/test 通过视为等效
  G_stop: required                # 完成后显式确认
  G_risk: skipped                 # 低风险，跳过风险评估表
  G_permission: skipped           # 低权限影响范围
  G_hitl: skipped                 # Minimal flow 不需 HITL
  G_understanding: skipped        # 已由 Discovery 覆盖
roles:
  - Developer
execution_status_model:
  enforced: true
  values: [Completed, Skipped, Deferred, Escalated]
  skipped_requires_reason: true
```

## 2. Task Contract (Sync)

Router 选路完成后立即同步生成 TaskContract 见 `templates/task-state/CONTRACT.template.md`。
本节只放 cross-reference：

```yaml
contract_ref: .agent/state/1574df8b/CONTRACT.md
```

## 3. Risk & Rollback Pre-flight

```yaml
risk_score: low
risk_signals:
  - blast_radius_score=low
  - production_repo=no
  - adr_count=0
rollback_plan:
  steps:
    - rm -rf node_modules package-lock.json
    - git checkout -- .            # 若已有 git
    - 删除 .agent/state/1574df8b/
  cost: low
```

## 4. Escalation Triggers

```yaml
triggers:
  - condition: same_task_failures > 5
    escalate_to: human
  - condition: scope_drift == true
    escalate_to: human
  - condition: requires_new_adr == true
    escalate_to: human
```
