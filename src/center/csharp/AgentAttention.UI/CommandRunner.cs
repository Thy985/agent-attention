using System.Diagnostics;

namespace AgentAttention.UI;

public sealed record CommandOutcome(bool? Ok, string Message)
{
    public static CommandOutcome Success(string message) => new(true, message);
    public static CommandOutcome Failure(string message) => new(false, message);
    public static CommandOutcome Unknown() => new(null, "Outcome unknown — check the window or read state before trying again.");
}

/// <summary>Await acknowledgements; never repeat a possibly dispatched command as a CLI fallback.</summary>
public sealed class CommandRunner
{
    private readonly Func<bool> _connected;
    private readonly Func<string, string[], Task<PipeMessage?>> _send;
    private readonly Func<string, string[], Task<CommandOutcome>> _cli;
    public event Action<CommandOutcome>? Completed;
    public bool IsConnected => _connected();

    public CommandRunner(IpcClient? ipc, CliCommandRunner cli)
        : this(() => ipc?.IsConnected == true,
            (command, args) => ipc!.SendCommand(command, args), cli.RunAsync) { }

    // Injectable transports allow production command policy to be exercised without WPF.
    public CommandRunner(Func<bool> connected, Func<string, string[], Task<PipeMessage?>> send,
        Func<string, string[], Task<CommandOutcome>> cli)
    { _connected = connected; _send = send; _cli = cli; }

    public void MarkAllRead() => _ = MarkAllReadAsync();
    public void MarkRead(string eventId) => _ = MarkReadAsync(eventId);
    public void Jump(string agentId) => _ = JumpAsync(agentId);
    public Task<CommandOutcome> MarkAllReadAsync() => ExecuteAsync("mark-all-read");
    public Task<CommandOutcome> MarkReadAsync(string id) => ExecuteAsync("mark-event", id);
    public Task<CommandOutcome> JumpAsync(string id) => ExecuteAsync("jump", id);

    private async Task<CommandOutcome> ExecuteAsync(string command, params string[] args)
    {
        CommandOutcome outcome;
        try
        {
            if (_connected())
            {
                var reply = await _send(command, args).ConfigureAwait(false);
                outcome = reply?.Ok switch
                {
                    true => CommandOutcome.Success(command == "jump" ? "Window focus confirmed." : "Read state saved."),
                    false => CommandOutcome.Failure(command == "jump"
                        ? "Could not focus the window. The session may be closed or Windows may restrict focus."
                        : "Read update failed. Refresh and try again."),
                    _ => CommandOutcome.Unknown(),
                };
            }
            else outcome = await _cli(command, args).ConfigureAwait(false);
        }
        catch { outcome = CommandOutcome.Unknown(); }
        // Notification feedback must not turn a completed command into an unhandled UI event exception.
        try { Completed?.Invoke(outcome); } catch { }
        return outcome;
    }
}

public sealed class CliCommandRunner
{
    private readonly string _cliPath;
    public CliCommandRunner(string cliPath) => _cliPath = cliPath;

    public async Task<CommandOutcome> RunAsync(string command, string[] args)
    {
        if (string.IsNullOrWhiteSpace(_cliPath)) return CommandOutcome.Failure("Command entry point is unavailable.");
        var node = Environment.GetEnvironmentVariable("AGENT_ATTENTION_NODE");
        var info = new ProcessStartInfo
        {
            FileName = string.IsNullOrWhiteSpace(node) ? "node" : node,
            UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.ArgumentList.Add(_cliPath);
        info.ArgumentList.Add(command);
        foreach (var arg in args) info.ArgumentList.Add(arg);
        Process? process;
        try { process = Process.Start(info); }
        catch { return CommandOutcome.Failure("Could not start the command. Check the Node and CLI installation."); }
        if (process == null) return CommandOutcome.Failure("Could not start the command.");
        using (process)
        {
            // Drain both pipes concurrently. Never expose raw command output (which may contain private data) in UI.
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                await Task.WhenAll(output, error).WaitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return CommandOutcome.Unknown(); // command may already have affected state/focus
            }
            return process.ExitCode == 0
                ? CommandOutcome.Success(command == "jump" ? "Window focus confirmed." : "Read state saved.")
                : CommandOutcome.Failure(command == "jump" ? "Could not focus the window. Check that the session is still open."
                    : "Read update failed. Refresh and try again.");
        }
    }
}
