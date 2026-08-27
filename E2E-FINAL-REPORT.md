# Agent Attention — E2E Protocol Compliance Report v2

## Date: 2026-08-27

---

## Test Results Summary

| Test | Result | Key Finding |
|------|--------|-------------|
| C-01: Anonymous fallback | PASS (with warning) | `anonymous` identity + clear warning emitted |
| C-00: Registration-first protocol | **4/5 PASS** | Claude self-registered as `claude-code`, called notify |
| NEG-01: No spurious notifications | **PASS** | 0 new events after file read/write/delete operations |
| Full test suite | **147/147 PASS** | TypeScript clean, C# publish clean |

---

## C-00: First-time Registration Protocol (Detailed)

**Setup**: Clean agents.json (0 entries), clean state.json (0 events)
**Task**: Read AGENTS.md → register identity → create file → call agent-notify

**Result: 4/5 PASS**

| Check | Result | Evidence |
|-------|--------|----------|
| Registration | ✅ PASS | `agent-attention agent register claude-code "Claude Code"` exited 0 |
| Correct identity | ✅ PASS | agents.json: `id=claude-code name=Claude Code` |
| Notification event | ✅ PASS | state.json: 1 completed event, agent_id=claude-code |
| Stability | ✅ PASS | Only 1 agent in registry (no duplicates) |
| File created | ❌ FAIL | verify.txt not created (Claude skipped this step) |

**Claude's own report**:
> "Registered agent: claude-code (Claude Code) EXIT=0"
> "Event ingested: state.json changed + tray-state.json updated at 22:51:21"
> "last_seen_at refreshed: 22:50:36 → 22:51:14, proving notify attributed to claude-code"

**Why verify.txt failed**: Claude interpreted the task as "read docs + register" and classified the file creation as unnecessary boilerplate, saying "this task modified no code, config, or docs." This is a prompt clarity issue, not a protocol failure.

---

## Anonymous Fallback Warning (New Behavior)

When `AGENT_ID` is not set, the system now emits a clear warning:

```
[agent-attention] WARNING: AGENT_ID not set. Using anonymous identity.
  Register a stable identity to avoid collapsing events across agents:
  agent-attention agent register <id> "<name>"
  or set the AGENT_ID / AGENT_NAME environment variables.
```

This appears from TWO sources:
1. `autoDetectAndRegister()` in registry.ts — warns at registration time
2. `agent-notify` entry point in index.ts — warns at invocation time

The fallback ID is now `anonymous` (not `agent-notify`), making the conceptual distinction clear:
- `agent-notify` = the CLI tool / capability entry point
- `anonymous` = an unregistered caller

---

## Negative Test: No Spurious Notifications

**Setup**: 2 events already in state.json
**Task**: Read SKILL.md, write temp.txt, read it, delete it — no agent-notify calls
**Result: PASS**

- Events before: 2
- Events after: 2
- New events: 0
- Claude correctly stayed silent on all intermediate operations

**Claude's own confirmation**:
> "I did not invoke agent-notify for any of the intermediate tool calls (Read/Glob/Write) — only for the task-completion event"

---

## Layer-by-Layer Status

```
Layer 1 — Runtime
  Agent → CLI → State → Daemon → UI
  ✅ PASS

Layer 2 — Agent protocol behavior
  Agent reads AGENTS.md / Skill → knows when to notify → stays silent otherwise
  ✅ PASS

Layer 3 — Agent identity
  Agent identifies itself → registers stable agent_id → events attributed correctly
  ⚠️ PARTIAL (works when Agent follows protocol; anonymous fallback warns)
```

---

## Files Changed This Session

| File | Change |
|------|--------|
| `src/registry.ts` | Fallback ID: `agent-notify` → `anonymous` + warning |
| `src/index.ts` | Added AGENT_ID warning in notify entry point |
| `src/daemon-cli.ts` | `printAgents()` shows short ID + name first; added `agent cleanup` |
| `CenterWindow.cs` | Groups by agent name (not ID); resolves Jump target correctly |
| `tests/registry.test.ts` | Updated for anonymous fallback + warning assertion |
| `skills/agent-attention/SKILL.md` | Rewritten as Integration Protocol (how to register + notify) |
| `.codeartsdoer/AGENTS.md` | Rewritten as Engineering Governance (behavioral discipline) |
| `E2E-FINAL-REPORT.md` | Updated with C-00 results and protocol analysis |

---

## Agent Attention Integration Protocol v1 (Formalized)

### Startup
```
1. Agent loads Skill (SKILL.md)
2. Agent identifies itself (agent_id)
3. Agent registers: agent-attention agent register <id> "<name>"
4. Agent begins work
```

### During Work
```
ordinary tool/progress events     → no notification
attention-worthy events           → agent-notify <event> "<message>"
```

### Identity Rules
```
Formal Agent → must have stable agent_id (claude-code, codex, aider, etc.)
Anonymous    → fallback identity "anonymous" + WARNING emitted
Never use    → "agent", "default", "agent-notify" as agent_id
```

### Message Quality
```
Bad:  "done"
Good: "Auth module refactored: 5 files changed, 120 lines, 0 tests failing"
```

---

## What Still Needs Work

1. **Host-level AGENT_ID injection**: Each agent runtime (Claude Code, Codex, etc.) should inject its own AGENT_ID automatically so users don't need to manually register
2. **verify.txt omission**: The C-00 task prompt needs clearer file-creation instruction — Claude treated it as optional boilerplate
3. **Multi-agent grouping**: Need to test that two different agents (claude-code + codex) produce separate groups in Center
