---
name: agent-attention
description: >
  Local notification center for AI agents. Agents call `agent-notify` when they
  need user attention — task completed, permission required, input needed, or
  failed. The Runtime surfaces these as Windows Toast + Sound + Tray icon, and
  the Center window shows an event timeline grouped by agent.
  Triggers: agent completes a task, needs authorization, blocks on input, or encounters an error.
triggers:
  - "agent task completed"
  - "need user approval"
  - "waiting for input"
  - "agent failed"
  - "send notification to user"
  - "agent notify"
  - "show toast to user"
---

# Agent Attention — Integration Protocol

> **Identity Principle**: Agent identity is declared by the Agent, never inferred by the Runtime.
> The only authoritative source of `agent_id` is the Agent itself via `AGENT_ID`.

## Overview

Agent Attention provides a local notification infrastructure for AI agents.
When an agent needs user attention, it calls `agent-notify` which stores
the event in `state.json` and surfaces it in the Center window.

```
Agent → agent-notify → daemon → Toast + Sound + Tray Icon + Center
```

## When to trigger (required — detection-driven)

Call `agent-notify` **whenever** one of these conditions is met — you do NOT
need to judge whether it is "worth" notifying. The Runtime handles dedup,
priority, and silence; your job is to signal the event.

| Condition | Event | Example message |
|-----------|-------|-----------------|
| Task finished successfully | `completed` | "Auth refactor done: 5 files, 120 lines" |
| Need user approval for a risky action | `permission_required` | "Approve deploying to production?" |
| Need user input to proceed | `input_required` | "Which framework: React or Vue?" |
| Task failed with an error | `failed` | "Tests failed: 3 assertions in auth.test.ts" |

**Stay silent** for: tool calls, thinking steps, intermediate file writes,
progress updates, passing test runs, sub-agent progress.

## Step 1: Register Identity (One-Time)

Every agent MUST have a stable `agent_id`. This is how the Center groups
events from the same logical agent across multiple processes and sessions.

```bash
agent-attention agent register <id> "<name>"
```

**Valid agent_id rules**: lowercase, alphanumeric, hyphens. No spaces.
**Examples**: `claude-code`, `codex`, `aider`, `my-project-agent`
**Never use**: `agent`, `default`, `anonymous` — these are reserved or signal "I forgot to identify myself."

Registration is idempotent. Running it again updates `last_seen_at` but does not create duplicates.

## Step 2: Set Agent Identity (Per-Session)

Set `AGENT_ID` in your environment before calling `agent-notify`:

```bash
export AGENT_ID=claude-code
export AGENT_NAME="Claude Code"
```

Or inline:

```bash
AGENT_ID=claude-code agent-notify completed "Task done"
```

The Runtime uses `AGENT_ID` exclusively. It does NOT auto-detect agents from
process names, hostnames, PIDs, or working directories.

## Step 3: Send Notifications

```bash
agent-notify <event> "<message>"
```

## Examples

```bash
# Task completed
agent-notify completed "Refactoring complete: 12 files changed"

# Waiting for authorization
agent-notify permission_required "Codex requests: execute git push origin main"

# Waiting for user input
agent-notify input_required "Please choose: A or B?"

# Task failed
agent-notify failed "Unit tests failed: 3 assertions in auth.test.ts"
```

## Message quality

Good messages answer: **what happened, why it matters, what next?**

```
Bad:   "done"
Good:  "Auth module refactored: 5 files changed, 120 lines, 0 tests failing"

Bad:   "error"
Good:  "Unit tests failed: 3 assertions in auth.test.ts — run npm test to see details"

Bad:   "need input"
Good:  "Which branch should I merge into main? (feature-x or hotfix-y)"
```

## CLI Reference

```bash
agent-attention daemon start        # Start the background daemon
agent-attention daemon status       # Check if running
agent-attention agent register <id> "<name>"  # Register an agent (one-time)
agent-attention agent list          # List registered agents
agent-attention agent cleanup       # Remove inactive agents (7+ days)
agent-attention mark-all-read       # Clear all notifications
agent-attention logs [n]            # Show recent daemon logs
agent-attention doctor              # Run health checks
```

## Principles

1. **Best-effort** — notification failure must never abort the agent task
2. **No auto-focus** — notifications show silently; user clicks to investigate
3. **Stable identity** — one `agent_id` per logical agent, declared explicitly
4. **Dedup** — identical events within 30s are suppressed
5. **No guessing** — the Runtime never infers agent identity from runtime detection
6. **Detection > judgment** — signal when conditions are met; do not judge whether the user
   already knows. The user leaving the terminal to browse the web is precisely the scenario
   this system exists for.
