using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace AgentAttention.UI;

public sealed record CenterSnapshot(AttentionState State, AgentRegistry Registry, List<AgentSummary> Agents);

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
        var agents = BuildAgentSummaries(state, registry);
        return new CenterSnapshot(state, registry, agents);
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
