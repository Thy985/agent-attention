# IPC client regression harness

Run with the .NET 10 SDK:

```sh
dotnet run --project tests/ipc-client-harness/IpcClientHarness.csproj -c Release
```

This executable compiles the production `IpcClient.cs`, `StateStore.cs`, and `Models.cs` directly. It uses real loopback TCP sockets and temporary state files, with fake daemon responses. Only `UiOptions` is replaced with test paths, because the normal options class calls Windows identity APIs.

The harness checks authenticated commands, matching acknowledgements on the command socket, Unicode arguments, rejection, nested status payloads, state-file reload, port/token rotation on reconnect, and cancellation. It throws and exits nonzero on failure.

It does not launch the real Node daemon, Windows Toasts, WPF windows, or NotifyIcon. Windows desktop acceptance is still required; see `docs/IPC-RELIABILITY-REVIEW-2026-10-21.md`.
