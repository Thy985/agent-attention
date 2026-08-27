# Agent Attention — E2E Protocol Compliance Report

## Test Date
2026-08-27

## Test Environment
- Claude Code version: 2.1.234
- agent-attention: 0.2.0
- Runtime: Windows 11, daemon running (PID 29996)

---

## E2E Case C-01: Agent Registration Identity

**Setup**: Clean agents.json (0 entries), clean state.json (0 events)
**Task**: Read SKILL.md → create file → call \gent-notify completed\

**Result: FAIL (0/5)**

| Check | Result | Evidence |
|-------|--------|----------|
| Registration | FAIL | agents.json has 0 entries after test |
| Correct identity | FAIL | No agent registered at all |
| Notification event | FAIL | state.json has 0 events |
| Process evidence | FAIL | No \gent-notify\ process observed |
| Task completion | PASS | result.txt created with "E2E" |

**Key finding**: Claude Code READ the SKILL.md (confirmed by output referencing it), but did NOT execute \gent-notify\. The skill was observed but not followed.

---

## E2E Case C-02: Completed Event (Prior Test)

**Setup**: agents had \gent-notify\ entry from earlier development
**Task**: Create file → call \gent-notify completed\

**Result: 4/5 (identity gap)**

| Check | Result | Evidence |
|-------|--------|----------|
| Registration | PASS | agent-notify registered |
| Correct identity | FAIL | identity=\gent-notify\ (generic fallback, not \claude-code\) |
| Notification event | PASS | state.json has 1 completed event |
| Process evidence | FAIL | \--print\ mode may not spawn subprocesses visibly |
| Task completion | PASS | test-output.txt created |

**Key finding**: When \AGENT_ID\ env var is set, registration works. But without it, all anonymous invocations collapse to \gent-notify\ — which is the bug we just fixed in this session.

---

## Root Cause Analysis

### Why Claude Doesn't Follow the Skill Automatically

The SKILL.md at \skills/agent-attention/skill.md\ describes the protocol:
- \completed\ when task finishes
- \permission_required\ when awaiting authorization  
- \input_required\ when awaiting user input
- \ailed\ when task errors

But AGENTS.md only contains engineering context (TypeScript, NodeJS). **There is no behavioral instruction telling Claude to load and follow the Agent Attention skill.**

Claude Code treats SKILL.md as reference documentation, not as executable behavior. Without an explicit directive in AGENTS.md, the agent reads the skill but doesn't execute on it.

### What This Means for the Product

| Layer | Status | Gap |
|-------|--------|-----|
| Runtime (daemon/state/notification) | WORKS | Events are correctly stored and displayed |
| CLI (agent-notify/agent list/agent cleanup) | WORKS | All commands function correctly |
| Agent Identity (registry grouping) | FIXED | Center now groups by name, not ID |
| **Agent Behavior Contract** | **BROKEN** | **Agents don't call agent-notify automatically** |

---

## Recommended Fix: Add Agent Protocol to AGENTS.md

AGENTS.md must include a section that tells Claude Code to:
1. Load the Agent Attention skill on startup
2. Register with a stable identity (AGENT_ID)
3. Call \gent-notify\ at the right times
4. Stay silent on normal operations

See \FIX-AGENTS-MD\ below.
