# M2 L3 Evidence Report

Date: 2026-08-23

## Decision

**M1 engineering baseline: PASS.**  
**M1 user-level migration acceptance / v0.3: NOT COMPLETE.**

The native host has replaced the PowerShell UI process topology without breaking the TypeScript core, but one required behavioral-parity oracle remains unavailable in this execution environment. Therefore M1 must remain open until that evidence is obtained on an interactive desktop or through a separately approved test mechanism.

## Verified Topology

```text
Node/TS Core
    ↓
daemon
    ↓
AgentAttention.UI.exe
    ├── WinForms Tray
    └── WPF Center
```

## Evidence Matrix

| Area | Result | Reproducer / Evidence |
|---|---|---|
| TypeScript build | **PASS** | `npm run build` — clean |
| Native publish | **PASS** | `npm run publish:ui` — 0 warnings / 0 errors |
| TypeScript/Jest | **PASS** | `npm test -- --runInBand`; 11 suites, 92 tests |
| WPF interaction harness | **PASS** | `npm run test:ui:harness`; 20 assertions |
| Single instance / activation | **PASS** | `scripts/verify-csharp-lifecycle.ps1` |
| Real daemon-owned stop/restart | **PASS** | `scripts/verify-csharp-lifecycle.ps1`; no zombie UI after stop/restart rounds |
| No duplicate Host process | **PASS** | Lifecycle matrix reports process count `1` |
| npm pack → isolated install | **PASS** | `scripts/verify-csharp-package.ps1`; 14/14 |
| Installed global launchers | **PASS** | Isolated `.bin` shims execute with expected contracts |
| Bundled C# executable resolution | **PASS** | Installed-layout resolver probe finds `AgentAttention.UI.exe` |
| No accidental `Code.exe` launch | **PASS** | Installed Toast adapter contains no `Code.exe` launch target |
| Unread display / grouping | **PASS** | C# interaction harness covers zero/one/two unread and three agents |
| Mark all read state transition | **PASS** | Real button → fake CLI → state oracle; unread becomes zero |
| Close/hide while Tray Host lives | **PASS** | Interaction harness verifies hidden Center and retained Host |
| Legacy PowerShell click-for-click parity | **NOT VERIFIED** | Cross-process legacy WPF UIA failed with `0x8000FFFF E_UNEXPECTED`; input-injection fallback was blocked by local safety policy |
| Tray icon visual behavior | **NOT VERIFIED** | Requires interactive desktop observation |
| Tray left/right/double-click ergonomics | **NOT VERIFIED** | Requires human interaction |
| Center visual quality | **NOT VERIFIED** | Requires human review |
| Real terminal focus/jump | **NOT VERIFIED** | Harness proves command invocation, not actual terminal focus |
| Toast OS activation | **NOT VERIFIED** | Requires interactive Windows notification approval and activation |

## Behavioral Fix Included

The legacy PowerShell Center closes its window after **Mark all read**. The C# Center previously remained visible. It now invokes the CLI and hides the Center while the WinForms Tray Host remains alive, preserving the legacy Center behavior without reintroducing a second process lifetime.

This is covered by the interaction harness and the new PowerShell/C# parity script's C# branch.

## Shutdown Evidence Clarification

Two shutdown paths are deliberately separated:

1. **Direct File-as-Truth trigger** — removal of `tray-state.json` causes graceful exit: previous baseline PASS and still represented by the manual phase in the lifecycle matrix.
2. **Real daemon ownership** — `createDaemon()` starts the native Host, records its PID, stops it, and confirms no zombie: current lifecycle matrix PASS across restart rounds.

## Packaging Manifest Correction

`package.json.files` now includes:

```text
src/center/csharp/dist/win-x64/**/*
```

The isolated install smoke confirms these installed artifacts:

```text
dist/daemon-cli.js
src/center/CenterWindow.ps1
src/center/TrayIcon.ps1
src/center/csharp/dist/win-x64/AgentAttention.UI.exe
src/center/csharp/dist/win-x64/AgentAttention.UI.dll
src/center/csharp/dist/win-x64/AgentAttention.UI.runtimeconfig.json
node_modules/.bin/agent-attention.cmd
node_modules/.bin/agent-notify.cmd
```

## M2 L3 Gate Command

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-ui-m1.ps1
```

Because the legacy click-parity oracle is currently `NOT VERIFIED`, the strict gate fails. For CI/evidence snapshots where the known environmental gap is accepted, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-ui-m1.ps1 -AllowPartialEvidence
```

That mode reports **PASS WITH EXPLICIT EVIDENCE GAP**, not full M1 completion.

#
## M2 L3 Verification Results (2026-08-23)

| Area | Result | Reproducer / Evidence |
|---|---|---|
| TypeScript build | **PASS** | `npm run build` — clean |
| Native publish | **PASS** | `npm run publish:ui` — 0 warnings |
| Jest full suite | **PASS** | 13 suites, 105 tests |
| C# interaction harness | **PASS** | 20 assertions |
| Lifecycle matrix (real process) | **PASS** | `scripts/verify-csharp-lifecycle.ps1`; 13/13 |
| Packaging/install smoke | **PASS** | `scripts/verify-csharp-package.ps1`; 14/14 |
| Daemon/C# spawn args (mocked) | **PASS** | `tests/daemon-csharp.test.ts`; 6 tests |
| Toast path resolution (source+compiled) | **PASS** | `tests/toast-integration.test.ts`; 7 tests |
| Legacy PowerShell click parity | **NOT VERIFIED** | Cross-process legacy WPF automation unavailable |
| Human tray UX | **NOT VERIFIED** | Requires interactive desktop observation |
| Real terminal focus/jump | **NOT VERIFIED** | Harness proves invocation, not actual focus |
| Toast OS activation | **NOT VERIFIED** | Requires interactive notification approval |# Required Before M1 Completion

1. Run the legacy PowerShell Center and C# Center against the same fixtures on an interactive desktop.
2. Complete the observable parity rows: unread states, event types, grouping, refresh, mark all read, close/hide, and jump invocation.
3. Perform human Tray/Center UX review.
4. Verify real terminal focus and Toast activation.
5. Re-run the strict M1 gate without `-AllowPartialEvidence`.


