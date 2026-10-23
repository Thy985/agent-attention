# Agent capability matrix — evidence-scoped implementation

Updated for the local #3/#4 implementation. No live vendor CLI or Windows desktop
acceptance is implied by this matrix. See [EVENT-CONTRACT.md](EVENT-CONTRACT.md)
for the full mapping, official versioned fixtures and compatibility limits.

| Entry | Implemented evidence | Forbidden inference | Acceptance state |
|---|---|---|---|
| Explicit CLI / Skill | Sender reports completed/failed/permission/input; optional session/task/stable delivery IDs | Sender statement is not independent business acceptance | Local CLI contract/regression coverage |
| Claude Code hooks | SDK 0.3.306 fields: Notification(permission_prompt), Elicitation, StopFailure; explicit PermissionRequest parser | Stop, SessionEnd, TaskCompleted and tool success never prove completed | Official doc/SDK fixtures and subprocess tests; live CLI remains untested |
| Process wrapper (e.g. Codex/Aider) | Nonzero exit except 130/143 as process-scoped failure/unknown task | Exit 0 is not business success; cancellation is not input_required | Local parser tests; vendor behavior not certified |
| Cline hook | No versioned provider contract implemented | Cannot borrow Claude fields or reliability | Experimental; install rejected rather than writing invalid Claude config |
| Generic OpenCode plugin | No generic status-to-outcome inference | status=success/error is not task outcome evidence | Experimental; versioned provider still required |
| Continue Skill | Explicit report fallback only | MCP presence supplies no automatic lifecycle completion | Experimental |
| MCP query/read interfaces | Existing query/read semantics retained | Query/tool success never generates completed | Not a general lifecycle integration |

L0–L7 are retained compatibility identifiers, not a protocol trust ranking.
“verified” means the chosen fields satisfy a specific signal contract and scope;
it never proves a task was successfully delivered. Completion reliability is
computed only from the completed event mapping, not borrowed from permission or
input signals. Unknown fields/events do not manufacture a notification.

Native Claude config is `.claude/settings.json`. Install/uninstall preserves
unrelated settings/commands; malformed settings fail without overwriting.
`setup hook --verify` inspects local registration only, not live provider health.
The parser never emits approval/denial or answers elicitation.

The [superseded August survey](archive/AGENT_CAPABILITY_SURVEY-2026-08-30.md)
is retained only as historical research. Its invented exitStatus/turns contract,
hooks.json installation path, support badges and lifecycle assertions are not
current behavior or support promises.

## Linux headless milestone

See [Linux headless](LINUX-HEADLESS.md): shared state v1/registry and evidence semantics, real CLI/loopback/MCP query/read/restart acceptance; desktop delivery, UI opening, target activation and autostart are explicitly unsupported. The automatic observer is disabled. This is not Linux desktop acceptance or a new Agent completion guarantee.
