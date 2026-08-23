using System.IO;
using System.Text.Json;

namespace AgentAttention.UI;

public sealed record CenterSnapshot(AttentionState State, AgentRegistry Registry);

public sealed class StateStore
{
    private readonly string _statePath;
    private readonly string _registryPath;
    private readonly string _trayStatePath;

    public StateStore(UiOptions options)
    {
        _statePath = options.StatePath;
        _registryPath = options.RegistryPath;
        _trayStatePath = string.IsNullOrWhiteSpace(options.TrayStatePath)
            ? Path.Combine(Path.GetDirectoryName(options.StatePath) ?? ".", "tray-state.json")
            : options.TrayStatePath;
    }

    public AttentionState ReadTrayState()
    {
        if (File.Exists(_trayStatePath))
        {
            return Deserialize<AttentionState>(File.ReadAllText(_trayStatePath)) ?? AttentionState.Default;
        }

        return File.Exists(_statePath) ? ReadAttentionState() : AttentionState.Default;
    }

    public CenterSnapshot ReadCenterSnapshot()
    {
        var state = ReadAttentionState();
        var registry = File.Exists(_registryPath)
            ? Deserialize<AgentRegistry>(File.ReadAllText(_registryPath)) ?? new AgentRegistry()
            : new AgentRegistry();
        return new CenterSnapshot(state, registry);
    }

    private AttentionState ReadAttentionState()
    {
        return Deserialize<AttentionState>(File.ReadAllText(_statePath)) ?? AttentionState.Default;
    }

    private static T? Deserialize<T>(string json) where T : class
    {
        try
        {
            return JsonSerializer.Deserialize<T>(json, Json.Options);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}
