# Agent Attention — Integration Protocol

> **Identity Principle**: Agent identity is declared by the Agent, never inferred by the Runtime.
> The only authoritative source of `agent_id` is the Agent itself via `AGENT_ID`.

## Overview

Agent Attention provides a local notification infrastructure for AI agents.
When an agent needs user attention, it calls `agent-notify` which stores
the event in `state.json` and surfaces it in the Center window.

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

## Event Types

| Event | When to call | Priority |
|-------|-------------|----------|
| `completed` | Task finishes successfully | P2 |
| `permission_required` | Needs user authorization before continuing | P0 |
| `input_required` | Needs user input before continuing | P0 |
| `failed` | Task failed with an error | P1 |

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

## CLI Reference

```bash
agent-attention daemon start        # Start the background daemon
agent-attention daemon status       # Check if running
agent-attention agent register <id> "<name>"  # Register an agent (one-time)
agent-attention agent list          # List registered agents
agent-attention agent cleanup       # Remove inactive agents (7+ days)
agent-attention mark-all-read       # Clear all notifications
agent-attention logs [n]            # Show recent daemon logs
```

## Principles

1. **Best-effort** — notification failure must never abort the agent task
2. **No auto-focus** — notifications show silently; user clicks to investigate
3. **Stable identity** — one `agent_id` per logical agent, declared explicitly
4. **Dedup** — identical events within 30s are suppressed
5. **No guessing** — the Runtime never infers agent identity from runtime detection
