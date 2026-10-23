using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace AgentAttention.UI;

public sealed record CenterSnapshot(AttentionState State, AgentRegistry Registry, List<AgentSummary> Agents, string? Error = null);

public sealed record TraySnapshot(AttentionState State, string? Error = null, bool HasSnapshot = true);

public sealed class StateStore
{
    private readonly string _statePath;
    private readonly string _registryPath;
    private readonly string _trayStatePath;

    private readonly Func<string, string> _readText;
    private readonly object _trayLock = new();
    private TraySnapshot? _lastTraySnapshot;

    public StateStore(UiOptions options, Func<string, string>? readText = null)
    {
        _readText = readText ?? File.ReadAllText;
        _statePath = options.StatePath;
        _registryPath = options.RegistryPath;
        _trayStatePath = string.IsNullOrWhiteSpace(options.TrayStatePath)
            ? Path.Combine(Path.GetDirectoryName(options.StatePath) ?? ".", "tray-state.json")
            : options.TrayStatePath;
    }

    // Keep the legacy IPC-reader API; tray presentation uses the snapshot including its error.
    public AttentionState ReadTrayState() => ReadTraySnapshot().State;

    public TraySnapshot ReadTraySnapshot()
    {
        lock (_trayLock)
        {
            try
            {
                // A corrupt tray projection must not silently fall back to a potentially older
                // state.json and clear the error. Missing projection may use the primary state.
                var path = File.Exists(_trayStatePath) ? _trayStatePath : _statePath;
                var state = ParseState(_readText(path));
                return _lastTraySnapshot = new TraySnapshot(state);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
            {
                var last = _lastTraySnapshot ?? new TraySnapshot(new AttentionState(), HasSnapshot: false);
                return last with { Error = "Current data unavailable; showing the last available snapshot. Read actions are disabled." };
            }
        }
    }

    private static AttentionState ParseState(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number != 1 ||
            !root.TryGetProperty("events", out var events) || events.ValueKind != JsonValueKind.Array)
            throw new JsonException("Invalid state shape");
        var state = JsonSerializer.Deserialize<AttentionState>(json, Json.Options);
        if (state == null || state.Events == null ||
            state.Events.Any(e => e == null || string.IsNullOrWhiteSpace(e.Id)))
            throw new JsonException("Invalid state event");
        state.UnreadCount = state.Events.Count(e => !e.Read);
        return state;
    }

    private CenterSnapshot? _lastCenterSnapshot;

    public CenterSnapshot ReadCenterSnapshot()
    {
        try
        {
            var state = ParseState(_readText(_statePath));
            var registry = File.Exists(_registryPath)
                ? JsonSerializer.Deserialize<AgentRegistry>(File.ReadAllText(_registryPath), Json.Options)
                : new AgentRegistry();
            if (registry?.Agents == null || registry.Agents.Any(a => a == null)) throw new JsonException("Invalid registry shape");
            return _lastCenterSnapshot = new CenterSnapshot(state, registry, BuildAgentSummaries(state, registry));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            var last = _lastCenterSnapshot ?? new CenterSnapshot(new AttentionState(), new AgentRegistry(), new());
            return last with { Error = "Cannot load current data. Showing the last available snapshot; actions are unavailable until refresh succeeds." };
        }
    }

    private static List<AgentSummary> BuildAgentSummaries(AttentionState state, AgentRegistry registry)
    {
        var summaries = new List<AgentSummary>();
        foreach (var agent in registry.Agents)
        {
            var unreadCount = state.Events.Count(e => e.AgentId == agent.AgentId && !e.Read);
            summaries.Add(new AgentSummary
            {
                AgentId = agent.AgentId,
                Name = agent.Name,
                LastSeenAt = agent.LastSeenAt,
                UnreadCount = unreadCount,
                Target = agent.Target,
            });
        }
        // Sort: agents with unread events first, then by last_seen desc
        summaries.Sort((a, b) =>
        {
            if (a.UnreadCount != b.UnreadCount) return b.UnreadCount.CompareTo(a.UnreadCount);
            return b.LastSeenAt.CompareTo(a.LastSeenAt);
        });
        return summaries;
    }

}
