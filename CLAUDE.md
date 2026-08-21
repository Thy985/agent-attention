# Agent Attention — Claude Engineering Contract

## 1. Core Principle

Do not equate "code implemented" with "task completed".

A task is complete only when its acceptance criteria are verified with appropriate evidence.

For user-facing behavior, passing unit tests alone is NOT sufficient.

---

## 2. Required Workflow

For every non-trivial task, follow this order:

1. Read the relevant code and existing tests.
2. Identify or define Acceptance Criteria.
3. Determine the required verification level.
4. Implement the smallest correct change.
5. Run tests at the appropriate layers.
6. Run real-environment verification when OS/CLI/daemon/UI behavior is involved.
7. Compare actual results against every Acceptance Criterion.
8. Report evidence and known limitations.
9. Only then claim "complete".

Do not claim completion merely because TypeScript compiles or unit tests pass.

---

## 3. Verification Levels

Use the highest applicable level.

### L1 — Unit Test
For: pure functions, state transitions, parsing, deduplication, policy logic

### L2 — CLI Integration
For: command arguments, exit codes, stdout/stderr, State persistence, process behavior
Run the real CLI process. Do not only call internal functions.

### L3 — Windows Integration
Required for: Toast, Sound, PowerShell, Tray, daemon lifecycle, Windows-specific process behavior
Use the real Windows environment. Do not treat mocks as final verification.

### L4 — Real Agent E2E
Required when changing: Skill, Agent registration, agent-notify integration, end-user Agent workflow

### L5 — Manual UX Verification
Required for: Tray appearance, notification visibility, sound, popup interaction

---

## 4. Completion Rules

You MUST distinguish: Implemented / Unit tested / Integration tested / E2E verified / Manually verified.

Never use "all tests passed" as a synonym for "feature complete".

If an acceptance criterion has not been verified, mark it as NOT VERIFIED.

---

## 5. Evidence-Based Reporting

Every completed task must report: Implementation, Acceptance Criteria, Tests, Real Environment, Known Issues, Evidence.

---

## 6. Honest Completion

Do NOT: invent test results, call a script-driven internal function an E2E test, report mocked Windows behavior as real Windows verification, report compilation success as feature verification, omit known failures because unrelated tests pass, claim "done" when required verification was skipped.

---

## 7. Agent Attention v0.2 Specific Requirements

- v0.1 CLI syntax remains compatible
- Agent registration must record stable agent_id and display name
- CLI remains usable when daemon is not running
- 30-second dedup is owned by the CLI/notification ingress
- State stores the most recent 20 accepted attention events
- Toast and sound must be best-effort and bounded by timeout
- Daemon is a UI process, not the source of truth
- Daemon restart must preserve State
- Real Agent → Skill → CLI → Windows E2E is required before v0.2 can be declared complete

---

## 8. Testing Anti-Patterns

Do NOT consider these sufficient:
- Calling pipeline.handleEvent() and calling it E2E
- Testing a mocked Windows notification backend as Windows verification
- Writing a test that only asserts internal functions were called
- Adding superficial tests whose only purpose is to increase test count
- Replacing a failed real-world test with a synthetic unit test

---

## 9. Final Completion Statement

Before claiming completion, provide:
- Implementation: PASS/FAIL
- Unit Tests: PASS/FAIL
- CLI Integration: PASS/FAIL
- Windows Integration: PASS/FAIL
- Daemon/Tray: PASS/FAIL
- Real Agent E2E: PASS/FAIL
- Acceptance Criteria: X/Y verified
- Known Issues: ...

Only claim "Complete" when all required acceptance criteria are verified.

---

## 10. Self-Execution Before User Request

Do not equate "code written" with "task completed". A task is complete only when its acceptance criteria are verified with appropriate evidence.

For user-facing behavior, passing unit tests alone is NOT sufficient.

### Self-Execution Check

Before asking the user to perform a task, verify whether the task can be completed with available tools.

The agent MUST attempt to execute tasks itself when it has the necessary:
- shell access
- filesystem access
- CLI tools
- test harnesses
- browser automation
- application APIs
- project scripts

Do NOT ask the user to perform an action merely because it is:
- easier to ask
- visually convenient
- not yet automated
- unfamiliar
- outside the agent's preferred workflow

### Self-Execution Protocol

Before requesting user intervention:
1. Identify the exact blocking action.
2. Check whether an available tool can perform it.
3. Attempt the action when technically possible.
4. Collect evidence of failure if the attempt fails.
5. Only then request user assistance.

### Report Format

The final report must distinguish three statuses:

- **SELF_COMPLETED**: Task finished without user intervention. Evidence included.
- **SELF_ATTEMPTED_BUT_BLOCKED**: Agent tried to execute but encountered a hard block. Evidence of failure included.
- **USER_REQUIRED**: Agent could not complete even after full self-execution attempt.

Never report USER_REQUIRED without describing why the agent could not complete the action itself.

### Execution vs. Observation

"Do not confirm" ≠ "cannot test."

Agent should separate:
- **Execution**: ✅ (command ran, exit code 0, output captured)
- **System API**: ✅ (Windows notification API returned success)
- **Visual confirmation**: NOT OBSERVABLE (no UI automation capability)

Report each dimension independently. Do not collapse all three into a single "Test: ❌ need user."

### User Escalation Gate

Before reporting USER_REQUIRED, the agent MUST satisfy ALL of the following:

□ Checked available tools
□ Attempted automatic execution
□ Checked permissions
□ Checked alternative paths
□ Recorded failure reason
□ Confirmed not a normal environment issue

If any item is unchecked, the agent must attempt it before requesting user help.

### Agent Capability Boundary Judgment

Agents often conflate three different states:
1. "I can theoretically complete this."
2. "I can complete this in my current environment."
3. "I need user intervention."

This conflation causes agents to request user help when they could still execute themselves.

**Rule**: The agent's default assumption must be "I will try first." Only after exhaustive self-execution should the agent escalate.

---

## 11. v0.2 Agent Self-Execution Requirements (AC-17, AC-18, AC-19)

### AC-17：Agent Self-Execution
Agent 必须能够在无人工辅助的情况下完成所有其工具和权限允许完成的安装、配置、测试、启动、停止、重启、CLI 验证和 daemon 验证任务。

**失败标准**：Agent 在未尝试自动执行的情况下，以"需要用户参与"为理由停止工作，则该任务不视为完成。

### AC-18：Self-Execution Check
Agent 在请求用户介入之前，必须先经过 Self-Execution Check：
1. 识别具体阻塞操作
2. 检查可用工具能否执行
3. 尝试自动执行
4. 记录失败证据
5. 确认不是普通环境问题
6. 仍无法完成才请求用户

### AC-19：User Escalation Gate
Agent 报告 USER_REQUIRED 前必须满足：
□ 已检查可用工具 | □ 已尝试自动执行 | □ 已检查权限
□ 已检查替代路径 | □ 已记录失败原因 | □ 已确认不是普通环境问题

验收：所有 USER_REQUIRED 报告均包含以上检查项。
