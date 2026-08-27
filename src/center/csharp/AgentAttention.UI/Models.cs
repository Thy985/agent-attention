using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentAttention.UI;

public sealed class AttentionState
{
    [JsonPropertyName("version")] public int Version { get; set; } = 1;
    [JsonPropertyName("updatedAt")] public long UpdatedAt { get; set; }
    [JsonPropertyName("unreadCount")] public int UnreadCount { get; set; }
    [JsonPropertyName("visible")] public bool Visible { get; set; }
    [JsonPropertyName("events")] public List<StateEvent> Events { get; set; } = new();

    public static AttentionState Default { get; } = new()
    {
        UpdatedAt = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
    };
}

public sealed class StateEvent
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;
    [JsonPropertyName("timestamp")] public long Timestamp { get; set; }
    [JsonPropertyName("type")] public string Type { get; set; } = string.Empty;
    [JsonPropertyName("priority")] public string Priority { get; set; } = "P2";
    [JsonPropertyName("agent_id")] public string AgentId { get; set; } = string.Empty;
    [JsonPropertyName("agent_name")] public string AgentName { get; set; } = string.Empty;
    [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;
    [JsonPropertyName("message")] public string Message { get; set; } = string.Empty;
    [JsonPropertyName("read")] public bool Read { get; set; }
}

public sealed class AgentRegistry
{
    [JsonPropertyName("agents")] public List<Agent> Agents { get; set; } = new();
}

public sealed class Agent
{
    [JsonPropertyName("agent_id")] public string AgentId { get; set; } = string.Empty;
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("last_seen_at")] public long LastSeenAt { get; set; }
    [JsonPropertyName("target")] public AgentTarget? Target { get; set; }
}

public sealed class AgentTarget
{
    [JsonPropertyName("type")] public string Type { get; set; } = "terminal";
    [JsonPropertyName("pid")] public int Pid { get; set; }
}

/// <summary>
/// Aggregated agent summary combining registry info + unread event count.
/// Used in the Center window's agent overview section.
/// </summary>
public sealed class AgentSummary
{
    public string AgentId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long LastSeenAt { get; set; }
    public int UnreadCount { get; set; }
    public bool HasTarget => Target is { Pid: > 0 };
    public AgentTarget? Target { get; set; }

    /// <summary>Relative time string, e.g. "5m ago" or "just now".</summary>
    public string LastActiveAge => FormatAge(LastSeenAt);

    private static string FormatAge(long timestampMs)
    {
        var elapsed = DateTimeOffset.Now.ToUnixTimeMilliseconds() - timestampMs;
        if (elapsed < 60_000) return "just now";
        if (elapsed < 3_600_000) return $"{elapsed / 60_000}m ago";
        if (elapsed < 86_400_000) return $"{elapsed / 3_600_000}h ago";
        return $"{elapsed / 86_400_000}d ago";
    }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
    };
}
