# Agent Attention Center

Windows notification infrastructure for AI Agents. Agents call `agent-notify`; you see Toasts, hear sounds, and open the Center window to see everything in one place.

```
Agent → agent-notify → daemon → Toast + Sound + Tray Icon + Center
```

## Quick Start (4 commands)

```bash
# 1. Install
npm install -g agent-attention    # OR from source: npm install && npm run build && npm link

# 2. Verify everything works
agent-attention doctor

# 3. Find and enable your agents
agent-attention discover
agent-attention integrate claude-code

# 4. Install Claude Code hooks (auto-notifies on session end)
agent-attention hook install     # installs to current project's .claude/hooks.json
# OR for global install across all projects:
agent-attention hook install --global
```

That's it. Now set `AGENT_ID` in your agent's environment and start sending notifications:

```bash
export AGENT_ID=claude-code
agent-notify completed "Task done"
```

Or let the hooks handle it — when Claude Code exits, it automatically fires
`agent-notify` with the session outcome.

## Commands

```bash
# Setup & discovery
agent-attention discover          # Scan PATH for installed agents
agent-attention integrate <id>    # Enable integration (registers agent + writes config)
agent-attention setup             # Status overview + next steps

# Daemon control
agent-attention daemon start      # Start daemon (also registers auto-start on login)
agent-attention daemon stop
agent-attention doctor            # Full health check with runtime log summary

# Notifications
agent-notify <event> "<message>"  # Send a notification

# Events
agent-attention logs [n]          # Show recent logs
agent-attention logs --correlation <id>  # Trace a specific notification chain
agent-attention mark-all-read     # Clear all unread
```

## Events

| Event | Priority | When to use |
|-------|----------|-------------|
| `permission_required` | P0 | Needs user approval before continuing |
| `input_required` | P0 | Needs user input to proceed |
| `failed` | P1 | Task failed with an error |
| `completed` | P2 | Task finished successfully |

## How it works

```
1. Agent calls: agent-notify completed "message"
2. Runtime records event in ~/.agent-attention/state.json
3. Daemon pushes to IPC → Windows Toast + Sound + Tray Icon
4. Open Center (tray right-click) to see agent overview + timeline
```

The system tracks every notification with a **correlation ID** so you can trace the full chain:
```bash
agent-attention logs --correlation corr_xxx
# Shows: notify_called → compliance_check → event_recorded → state_changed
```

## Architecture

```
~/.agent-attention/
├── agents.json          # Registered agents (stable identity)
├── integrations.json    # Agent integration config
├── state.json           # Recent events (last 20)
├── logs/runtime.jsonl   # Unified observability log
├── daemon.pid           # Daemon PID
└── ipc-port.txt         # IPC port for UI ↔ daemon

Startup hook:
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-attention.vbs
```

## Requirements

- Windows 10/11
- Node.js >= 18

## Development

```bash
npm install
npm run build          # Compile TypeScript
npm run publish:ui     # Build C# UI (requires .NET SDK)
npm test               # Run test suite
```

## Known Limitations

- **Windows only** — macOS/Linux use different notification APIs
- **Requires AGENT_ID** — agents must set `AGENT_ID` env var for proper identification (the daemon warns if missing)
- **Target Jump needs PID** — agents must call `agent-attention agent target set <id> --pid <n>` for Focus to work
