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

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
    };
}
