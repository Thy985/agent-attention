# Agent Attention Skill

When the Agent detects any of the following events, it MUST call the `agent-notify` CLI.

## Must Notify

Call `agent-notify` for these four events:

| Event | When to trigger |
|-------|-----------------|
| `completed` | Task finishes successfully |
| `permission_required` | Agent needs user authorization for a action |
| `input_required` | Agent stops and waits for user input |
| `failed` | Task fails with an error |

## Do NOT Notify

Do NOT call `agent-notify` for:

- Normal tool calls
- Thinking steps
- File modifications
- Test runs (unless they fail)
- Progress updates

## Invocation

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

## Principles

1. **Minimal interruptions** — only notify when the user needs to return to the Agent
2. **Best-effort** — notification failure must never abort the Agent task
3. **No auto-focus** — notification shows silently; user clicks to investigate
