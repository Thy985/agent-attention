# Agent Attention Center

Lightweight local notification infrastructure for AI Agents.

## Install

```bash
npm install -g agent-attention
```

## Usage

```bash
agent-notify <event> <message>
```

### Events

| Event               | Priority | Sound   |
|---------------------|----------|---------|
| `permission_required` | P0       | urgent  |
| `input_required`      | P0       | urgent  |
| `failed`              | P1       | normal  |
| `completed`           | P2       | normal  |

### Examples

```bash
agent-notify completed "Task finished"
agent-notify permission_required "Codex needs git push approval"
agent-notify input_required "Waiting for your input"
agent-notify failed "Tests failed: 17/200"
```

## Config

Optional: `~/.agent-attention/config.yaml`

```yaml
enabled: true
sound:
  enabled: true
events:
  completed: true
  permission_required: true
  input_required: true
  failed: true
```

## Architecture

```
Agent / Skill
    ↓
agent-notify CLI
    ↓
Windows Toast + Sound
```

The CLI is a standalone component — Skills, Hooks, ACP, MCP can all invoke it.

## v0.2 — Tray Icon + State Persistence

v0.2 adds:
- Persistent state at `~/.agent-attention/state.json` (last 20 events)
- Windows Tray Icon + right-click Mini Panel
- Auto-start daemon (registers in `shell:startup`)

### Install daemon (Windows)

```bash
git clone <repo>
cd agent-attention
npm install
npm run build
npm link                # makes 'agent-notify' available globally
npm run bin:install     # registers daemon at Windows startup
```

The tray icon appears within a few seconds. On Windows reboot, the daemon starts automatically.

### Manual daemon control

```bash
npm run start:daemon    # foreground (debug mode)
npm run bin:uninstall   # remove startup hook + kill daemon
```

### Architecture

```
Agent / Skill
    ↓
agent-notify CLI
    ↓
Windows Toast + Sound
    ↓
State JSON (~/.agent-attention/state.json)
    ↓
daemon (long-running)
    ↓
PowerShell TrayIcon.ps1 → Tray Icon + Mini Panel
```

### Known limitations

1. **30s dedup is per-process.** `agent-notify` is a short-lived CLI; the dedup Map only catches duplicates within a single invocation. Across separate CLI calls within 30s, a Toast will fire twice. Fix is v0.3+.
2. **Tray menu items only show Toast on click.** They do NOT activate the originating Terminal/IDE. This is deferred (architecture doc §四).
3. **Windows-only.** macOS/Linux use different notification paths.
4. **Daemon is optional.** Without it, all v0.1 behavior still works (CLI → Toast+Sound).

### Verification (real Windows environment)

After install:
1. `agent-notify completed "v0.2 verify"` — Toast fires
2. Tray icon shows `🔴 1`
3. Right-click tray → see "🟢 agent · completed · Ns ago"
4. `agent-notify failed "test 2"` — Tray shows `🔴 2`
5. Right-click → "Mark all read" — Tray shows `●`
6. Right-click → "Clear all" — Menu shows "(no events)"
7. Reboot — Daemon auto-starts, Tray reappears within seconds

---

## v0.3 — Shared Registry + Multi-Agent Center

v0.3 extends the single-agent notification model to a shared Attention Center
where multiple registered Agents appear together in one lightweight WPF window.

### Core additions

| Feature | Description |
|---------|-------------|
| **Shared Registry** | `~/.agent-attention/agents.json` stores all registered agents machine-wide |
| **Agent Onboarding** | A development Agent (e.g. Claude Code) helps discover and connect other Agents; the target Agent self-registers — no daemon-driven auto-discovery |
| **Multi-Agent Center** | WPF popup (`CenterWindow.ps1`) groups events by Agent, shows per-agent unread counts, priority colors, and connection status |
| **Target Jump** | Clicking an event attempts to bring the originating Terminal to focus (best-effort; failure degrades gracefully) |
| **Tray simplification** | Right-click menu now has `Open Attention Center` + `Mark all read` + `Exit` |

### Architecture

```
Agent / Skill
    ↓
agent-notify CLI  (auto-detects agent_id, writes to agents.json)
    ↓
Windows Toast + Sound
    ↓
State JSON (~/.agent-attention/state.json) — per-agent query functions
    ↓
daemon (long-running) — pushes per-agent unread counts to tray
    ↓
PowerShell TrayIcon.ps1 → Tray Icon + Mini Panel
    ↓
PowerShell CenterWindow.ps1 → WPF Popup (agent-grouped events)
```

### New CLI commands

Two CLIs are now available:

```bash
# v0.1/v0.2 — notification sender
agent-notify <event> <message>

# v0.3+ — daemon + agent management
agent-attention <command> [args]
```

#### Daemon control

```bash
agent-attention daemon start     # Start the daemon in background
agent-attention daemon stop      # Stop the daemon
agent-attention daemon restart   # Restart the daemon
agent-attention daemon status    # Show PID, tray status, health
agent-attention doctor           # Full health-check report
```

#### Agent registry

```bash
# Register an agent (run from the agent's own process)
agent-attention agent register <id> <name>
# Example:
agent-attention agent register claude-code "Claude Code"
agent-attention agent register codex "Codex"

# List all registered agents with connection status
agent-attention agent list
```

#### Target Jump

```bash
# Set a terminal PID target (click event → focus that terminal)
agent-attention agent target set <id> --pid <n>
# Example:
agent-attention agent target set codex --pid 12345

# Clear the target
agent-attention agent target clear <id>
```

#### Center Window

The Center window opens from the Tray right-click menu or can be triggered programmatically.
It groups all events by Agent and shows:
- Per-agent unread count
- Connection status (`● Connected` / `○ Last seen N min ago`)
- Priority-colored dots (`🔴 P0` / `🟡 P1` / `🟢 P2`)

### Agent Onboarding workflow

Onboarding is done by a development Agent (e.g. Claude Code), NOT by the daemon:

```
1. Detect available Agent CLIs (Get-Command / which)
2. Read target Agent's plugin/skill installation docs
3. Help install Agent Attention skill for the target Agent
4. Ask target Agent to self-register:
     agent-attention agent register <id> <name>
5. Verify: agent-attention agent list
6. Test: agent-notify completed "onboarding test"
```

**Rule**: The daemon never scans processes or auto-writes agents.json.
The target Agent must self-register via the CLI.

### Verification (real Windows environment)

1. Register two agents:
   ```bash
   agent-attention agent register claude-code "Claude Code"
   agent-attention agent register codex "Codex"
   agent-attention agent list
   ```
2. Emit events from both:
   ```bash
   agent-notify completed "from claude"
   agent-notify permission_required "from codex — needs approval"
   ```
3. Open Center from tray right-click — expect grouped view with 2 Agent sections
4. `agent-attention agent target set codex --pid <your-terminal-pid>`
5. Click Codex's event in Center — Terminal should gain focus
6. Run `agent-attention doctor` — all checks green
