# Linux headless milestone (#5)

This is a local attention inbox backend, not a Linux desktop client. The same state v1,
registry, event contract and read operations are shared with Windows. No new parallel runtime,
cloud dependency, autostart service, tray or focus workaround is introduced.

## Run from source

Requires Node.js 18+ and the existing npm dependencies (`npm ci`, then `npm run build`).
Use Node entry points below before deciding to globally install/link this un-released source:

```sh
export AGENT_ATTENTION_HOME="$(mktemp -d /tmp/agent-attention-demo.XXXXXX)"
export AGENT_ATTENTION_MODE=headless
export AGENT_ID=my-agent
export AGENT_NAME='My Agent'
node dist/daemon-cli.js capabilities
node dist/daemon-cli.js daemon start --headless
node dist/index.js completed 'Explicit task completion report'
node dist/index.js failed 'Explicit failure report'
node dist/index.js input_required 'Choose a direction'
node dist/index.js permission_required 'Approval is needed'
node dist/daemon-cli.js events
node dist/daemon-cli.js mark-all-read
node dist/daemon-cli.js daemon restart
node dist/daemon-cli.js events
node dist/daemon-cli.js daemon stop
```

`daemon run --headless` runs in the foreground; SIGINT/SIGTERM stops it. `start`, `stop`,
`restart`, `status` are explicit background-process operations, not system service management.
Background lifecycle controls are Linux-only; other platforms may use foreground headless run.
`start` returns after PID ownership and discovery files are present; these are startup
indicators, not proof of desktop notification or ongoing service health. Startup/stop have
bounded waits. A timeout is an error, not permission to spawn another process blindly.
`doctor --headless` prints capability JSON, not a claim of a full environment acceptance pass.
`setup --headless` refuses autostart work. The automatic observer is disabled in headless mode.

Notification reporting is separate from recording: `agent-notify`/`dist/index.js` returns
`recorded: true, delivery: "unsupported"` here. Desktop delivery cannot swallow a retained event.
A duplicate returns `delivery: "suppressed"`. Windows adapter calls report `attempted`, not
independently verified display. `failed` describes an adapter failure, not loss of retained data.
The existing config enabled/event flags still gate event acceptance; explicitly disabled
reports are not retained. This behavior is unchanged and is distinct from unsupported delivery.

## Shared state and MCP

`AGENT_ATTENTION_HOME` is the full directory, not its parent. It has precedence over the
legacy MCP alias `AGENT_ATTENTION_STATE_DIR`; absent either, the default is `~/.agent-attention`.
Set the same variables on CLI, daemon and MCP processes. The MCP stdio entry point is
`node dist/mcp-server.js`. Its `attention__get_events`, `attention__state`, `attention__agents`
and `attention__clear_events` operate on the same files; clear means mark read, not delete.
Nothing in this milestone grants or automatically answers an Agent permission request.

State remains version 1 with a maximum retained history of 20 events. The Linux end-to-end
test checks all four event kinds, authenticated loopback RPC, MCP stdio reads/read mutations,
identity, read state, restart, killed-owner recovery and concurrent process starts/writes.
No real Claude session or desktop session is represented by these tests.

## Persistence, retries and errors

State/registry read-modify-write transactions are serialized across processes using local
lock files and atomic replacement. Lock ownership is published complete; a confirmed dead
owner may be recovered. Live, malformed, or abandoned recovery guards time out with an error
rather than risking concurrent mutation. If investigation establishes that no writer is alive,
an operator may remove that stale guard; do not remove a live process's lock. Network filesystem
locking, PID-reuse-proof ownership and power-loss/fsync durability are not guaranteed.
Malformed state bytes are preserved in `state.json.corrupt` (first backup only), while the
next accepted write rebuilds state v1; this is recovery, not reconstruction of lost events.

Idempotence applies to retained source identity including Agent, session/task, event kind and
source event/contract. Supply a stable `AGENT_ATTENTION_EVENT_ID` plus session/task IDs on CLI
retry. An already-read retained event does not become unread on that retry. Unkeyed CLI reports
retain scoped same-message 30-second dedup. Evicted events can be re-accepted, and a crash between
persistence and desktop delivery is not reconciled as exactly-once display. No such guarantee
is made.

IPC binds loopback only, requires the existing token handshake, and writes discovery/token
files with mode 0600 on Linux. These do not defend against another process running as the same
OS user. Treat the whole state directory as private, keep it on a local filesystem, and do not
expose the TCP port or token to other users.

## Verification

```sh
node scripts/verify-core-baseline.mjs
# Requires .NET 10 on PATH for the existing production C# IPC harness.
# Linux-only real-process tests skip on other operating systems:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/platform-headless.test.ts
```

Windows remains supported through its existing platform implementation and previous repair
rounds. Windows-target compilation is not Windows desktop execution. Toast, tray, window focus,
installed EXE and live provider acceptance are separate outstanding checks. Do not close #3/#4/#5
as fully accepted merely from this headless milestone.
