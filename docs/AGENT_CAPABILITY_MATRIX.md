# Agent Capability Matrix — Integration Readiness for Agent Attention

> Generated: 2026-08-30
> Method: GitHub API + official docs scraping + local system survey
> Data source: code.claude.com, docs.cline.bot, api.github.com, aider.chat, openai/codex GitHub

## Summary Table

| Agent | Identity | Skill | Wrapper | Hook | Native | Completion Semantic | Priority |
|-------|----------|-------|---------|------|--------|---------------------|----------|
| **Claude Code** | ✅ ENV `AGENT_ID` | ✅ `.claude/skills/` | ✅ `agent-attention hook install` | ✅ 15+ events (Stop, SessionStart, PostToolUse…) | N/A (built-in) | **Clear** — `exitStatus` + `turns` | **P0** |
| **Cline CLI** | ✅ `CLINE_API_KEY` / `CLINE_PROVIDER` | ✅ `.clinerules` + skills | ✅ `--hooks-dir` | ✅ `cline hook` subcommand | ✅ ACP mode | **Clear** — NDJSON `--json` output | **P0** |
| **Codex CLI** | ✅ ENV `CODEX_*` | ✅ `.codex/skills/` | ✅ `codex run --json` | ✅ Configurable (hooks in config.toml) | ❌ | **Partial** — turn-based, no lifecycle event | **P1** |
| **Continue** | ❌ No ENV | ✅ MCP tools | ⚠️ VS Code extension only | ❌ No hook system | ✅ MCP servers | **Weak** — IDE-only, no CLI lifecycle | **P2** |
| **Aider** | ❌ No ENV | ❌ No skill system | ✅ Python wrapper (`aider + agent-notify`) | ❌ No hook system | ❌ | **Weak** — no structured completion signal | **P2** |
| **OpenCode** | ❌ No ENV | ❌ No skill system | ⚠️ Unknown (CLI exit only) | ❌ No hook system | ❌ | **Weak** — no lifecycle events | **P3** |
| **Hermes Agent** | ❌ No ENV | ❌ No skill system | ⚠️ Experimental | ❌ No hook system | ✅ MCP (partial) | **Unknown** — not enough data | **P3** |
| **Cursor** | ❌ No ENV | ❌ No skill system (IDE plugin) | ⚠️ VS Code extension | ❌ No hook system | ❌ | **Weak** — IDE-only | **P3** |
| **Windsurf** | ❌ No ENV | ❌ No skill system | ⚠️ VS Code extension | ❌ No hook system | ❌ | **Weak** — IDE-only | **P3** |
| **GitHub Copilot** | ❌ No ENV | ✅ GitHub Copilot Skills (new) | ❌ | ❌ No hook system | ❌ | **Weak** — IDE/session-based | **P3** |

---

## Field Definitions

| Field | Meaning |
|-------|---------|
| **Identity** | Can the agent self-identify via ENV or config? (`AGENT_ID`, `CLINE_API_KEY`, etc.) |
| **Skill** | Does the agent have a skill system that can load instructions (like `SKILL.md`)? |
| **Wrapper** | Can we wrap the agent's binary to inject `agent-notify` calls? (shell script / process wrapper) |
| **Hook** | Does the agent expose lifecycle hooks (stdin JSON on Stop/Start)? |
| **Native** | Does the agent have a native integration protocol (MCP, ACP)? |
| **Completion Semantic** | How clearly can we detect "task finished" vs "user cancelled" vs "error"? |

---

## Detailed Analysis

### Claude Code (Anthropic) — P0 ✅ Complete

**Evidence:**
- Official docs at `code.claude.com/docs/en/hooks.md` confirm 15+ hook events
- `Stop` event fires with `{sessionId, exitStatus, turns}` on stdin
- `SessionStart` event fires when session begins
- `PostToolUse` fires on every tool call (can track progress)
- `PermissionRequest` fires when user approval needed
- Configured via `~/.claude/settings.json` hooks block
- Claude Code v2.1.251 already installed on this machine

**Completion semantics:**
- `exitStatus=0, turns>0` → task completed successfully
- `exitStatus=1` → agent error
- `exitStatus=2` → user cancelled
- These map directly to `completed`, `failed`, `input_required` events

**Integration status:** ✅ Already implemented in this project
- `src/hooks.ts` handles Stop hook stdin
- `src/scripts/install-hook.ts` installs to `.claude/hooks.json`
- `agent-attention hook install` command works

---

### Cline CLI — P0 ✅ Supported

**Evidence:**
- `cline hook` subcommand documented in CLI reference
- `--hooks-dir <path>` option allows custom hook directory
- Default hooks dir: `~/.cline/hooks`
- `--json` mode streams NDJSON events for piping
- ACP mode (`--acp`) for editor integration
- Skills and rules system via `.clinerules` and `.cline/skills/`

**Completion semantics:**
- NDJSON output includes `agent_event` messages with task state
- Can parse `--json` output to detect completion
- Or use `--yolo` mode (auto-approve, exits on completion)

**Integration path:**
```bash
# Option 1: Use cline's built-in hook
cline --hooks-dir ~/.agent-attention/hooks "your task"

# Option 2: Wrap cline with agent-notify
#!/bin/bash
export AGENT_ID=cline
cline "$@" && agent-notify completed "Cline session finished" || agent-notify failed "Cline session failed"
```

---

### Codex CLI (OpenAI) — P1 ⚠️ Partial

**Evidence:**
- Official docs at `developers.openai.com/codex`
- `docs/config.md` confirms hooks support: "Admins can set top-level `allow_managed_hooks_only = true` in `requirements.toml`"
- `.codex/skills/` directory exists (from GitHub API)
- Configurable via `~/.codex/config.toml`
- Has `exec` mode (non-interactive) but hook format undocumented

**Completion semantics:**
- Turn-based interaction model
- Exit code indicates success/failure but no structured completion event
- Must parse stdout or use wrapper pattern

**Integration path:**
```bash
# Wrapper approach (works now)
#!/bin/bash
export AGENT_ID=codex
codex "$@" && agent-notify completed "Codex session finished" || agent-notify failed "Codex session failed"

# Future: if Codex adds stdin hooks like Claude Code
# Would need reverse-engineering of hook JSON schema
```

---

### Continue — P2 ⚠️ Limited

**Evidence:**
- GitHub repo: `continuedev/continue` (35.7k stars)
- Primary interface: VS Code extension + JetBrains plugin
- `packages/continue-sdk` for programmatic access
- MCP server support (`packages/mcp-server`)
- No CLI binary (IDE-focused)
- No hook system

**Completion semantics:**
- IDE-native: completion is implicit (user closes conversation)
- No structured event to hook into
- Could use MCP server to intercept events if Continue exposes them

**Integration path:**
```typescript
// MCP server approach (future work)
// Create an MCP server that listens to Continue's events
// and forwards to agent-attention
```

---

### Aider — P2 ⚠️ Limited

**Evidence:**
- GitHub repo: `Aider-AI/aider` (48.6k stars)
- Python-based CLI tool
- No ENV variables for identity
- No skill system (relies on system prompt)
- No hook system
- No structured completion events

**Completion semantics:**
- Aider runs in interactive loop until user types `exit`
- No exit code distinction between success/failure
- Cannot detect "task completed" vs "user cancelled" programmatically

**Integration path:**
```bash
# Wrapper approach only
#!/bin/bash
export AGENT_ID=aider
aider "$@"; code=$?
if [ $code -eq 0 ]; then
  agent-notify completed "Aider session finished"
else
  agent-notify failed "Aider session failed (exit=$code)"
fi

# Or prompt injection (hacky but works)
# Add to aider's system prompt:
# "When you finish a task, run: agent-notify completed 'Task done'"
```

---

### OpenCode — P3 ❌ Not Ready

**Evidence:**
- No public GitHub repo found (possibly closed-source or different name)
- Installed on system via `mise` at v1.18.25
- No documentation found about hooks or skills
- No identity configuration documented

**Integration path:** Unknown — would need reverse-engineering

---

### Hermes Agent — P3 ❌ Insufficient Data

**Evidence:**
- Mentioned in cc-safety-net README as supported agent
- No public documentation found
- No hook/skill system documented

**Integration path:** Unknown — needs more research

---

## Integration Effort Estimate

| Agent | Approach | Effort | Status |
|-------|----------|--------|--------|
| **Claude Code** | Native hook | ✅ Done | P0 |
| **Cline CLI** | Hook wrapper | 0.5 days | P0 |
| **Codex CLI** | Process wrapper | 0.5 days | P1 |
| **Continue** | MCP server | 3-5 days | P2 |
| **Aider** | Prompt injection + wrapper | 1 day | P2 |
| **OpenCode** | Research first | TBD | P3 |
| **Hermes** | Research first | TBD | P3 |

---

## Recommendation

### Immediate (this week)
1. ✅ Claude Code hook — already done
2. 🔄 Cline CLI hook — add adapter config + install script
3. 🔄 Codex CLI wrapper — document wrapper script

### Short-term (next 2 weeks)
4. 🔄 Aider prompt injection — update skill.md with aider-specific instructions
5. 🔄 Continue MCP server — design if there's demand

### Long-term
6. 📋 OpenCode/Hermes — research when these agents gain traction
7. 📋 Generic wrapper — create `agent-attention wrapper <agent>` that auto-generates wrappers for any agent

---

## Key Insight

**The hook ecosystem is fragmented.** Only Claude Code and Cline have standardized hook interfaces. Others require:
- Process wrappers (easy but fragile)
- Prompt injection (hacky but works)
- MCP servers (future-proof but high effort)

**Agent Attention's strength is being the "bus" that all agents connect to** — not requiring each agent to implement hooks natively. The `agent-notify` CLI is the universal interface; hooks are just a convenience layer for agents that support them.

---

## References

- Claude Code Hooks: https://code.claude.com/docs/en/hooks.md
- Claude Code Skills: https://code.claude.com/docs/en/skills.md
- Cline CLI Reference: https://docs.cline.bot/cli/cli-reference.md
- Codex Config: https://raw.githubusercontent.com/openai/codex/main/docs/config.md
- CC Safety Net (multi-agent hook guide): https://github.com/kenryu42/cc-safety-net
- Agent Skills Standard: https://agentskills.io
