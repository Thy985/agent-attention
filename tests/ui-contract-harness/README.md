# UI command/evidence contract harness

Run `dotnet run --project tests/ui-contract-harness/UiContractHarness.csproj -c Release` with .NET 10 and Node on PATH.

This links production CommandRunner, EventPresentation, Models, StateStore and IpcClient into a net10.0 console harness. Transport policy uses injected acknowledgements; CLI exit-code assertions launch a real isolated Node child; state fixtures live in a disposable temporary directory. It never reads the owner's real state/configuration.

These are 23 logic/contract assertions, not WPF/Tray/Toast rendering, keyboard, DPI or screen-reader acceptance. Actual WPF control wiring lives in `src/center/csharp/AgentAttention.UI.Harness` and must execute on Windows separately. Do not label cross-compilation as desktop testing.
