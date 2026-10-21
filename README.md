# Agent Attention Center

Local Agent attention inbox with a Windows desktop adapter and an explicit Linux headless backend. Agents report events through `agent-notify`; retained state, query and read operations are shared. Windows desktop delivery remains separately verified.

```
Agent → agent-notify → daemon → Toast + Sound + Tray Icon + Center
```

## Linux headless (source milestone)

See [Linux headless commands, persistence and limits](docs/LINUX-HEADLESS.md). Build the source, then select `AGENT_ATTENTION_MODE=headless` and an isolated `AGENT_ATTENTION_HOME` before `node dist/daemon-cli.js daemon start --headless`. This is not a Linux tray/Toast client; it installs no autostart service.

## Windows Quick Start (5 commands)

```bash
# 1. Install
npm install -g agent-attention    # OR from source: npm install && npm run build && npm link

# 2. Inspect local configuration (not desktop acceptance)
agent-attention doctor

# 3. Check integration capabilities
agent-attention integration list

# 4. Install agent integration
agent-attention integration install claude-code
# OR for other agents:
# agent-attention integration install codex   (wrapper)
# agent-attention integration install aider   (wrapper)

# 5. Start the daemon
agent-attention daemon start
```

That's it. Now set `AGENT_ID` in your agent's environment and start sending notifications:

```bash
export AGENT_ID=claude-code
agent-notify completed "Task done"
```

The versioned Claude hook adapter observes permission prompts, elicitation requests,
and response failures. Stop/session exit does **not** prove task completion, and
cancellation never becomes “needs input”. Explicit `completed` is a sender report,
not independent acceptance. Other integrations remain experimental until their
own event/version contract is validated. See the [event contract](docs/EVENT-CONTRACT.md).

## Commands

```bash
# Integration management (v0.3)
agent-attention integration list          # Show all agents and their integration levels
agent-attention integration status <id>   # Check integration status for an agent
agent-attention integration install <id>  # Install integration (hook/wrapper/skill)
agent-attention integration uninstall <id> # Remove integration

# Setup & discovery
agent-attention discover          # Scan PATH for installed agents
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
├── state.json           # Recent events (last 20)
├── dedup.json           # Deduplication cache (30s TTL)
├── logs/runtime.jsonl   # Unified observability log
├── daemon.pid           # Daemon PID
└── ipc-port.txt         # IPC port for UI ↔ daemon

Integration Catalog:
scripts/integrations/*.json  # Agent capability manifests (L0-L7)

Startup hook:
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-attention.vbs
```

## Integration Levels

L0–L7 are legacy mechanism identifiers, not reliability rankings.

| Mechanism | Current evidence boundary |
|-----------|---------------------------|
| Manual CLI / Skill | Explicit sender report only; outcome is not independently checked |
| Wrapper | Nonzero process exit observation; clean exit/cancel produces no outcome notice |
| Claude hook | Versioned, validated permission/input/response-failure signal, never task completion |
| Generic Plugin / other protocols | No generic lifecycle inference; MCP query success is not completion |

See [AGENT_CAPABILITY_MATRIX.md](docs/AGENT_CAPABILITY_MATRIX.md) for full details.

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

候选包、CI 分层与安装后检查见 [PACKAGE-ACCEPTANCE.md](docs/PACKAGE-ACCEPTANCE.md)。
