namespace AgentAttention.UI;

/// <summary>Presentation is scoped evidence, not a stronger interpretation of an Agent's report.</summary>
public static class EventPresentation
{
    public static string Label(StateEvent item)
    {
        if (item.Evidence?.Scope == "process" || item.Evidence?.Basis == "process_observation")
            return "PROCESS OBSERVATION — TASK OUTCOME UNKNOWN";
        return item.Type switch
        {
            "permission_required" => "PERMISSION REQUESTED",
            "input_required" => "INPUT REQUESTED",
            "failed" => item.Evidence?.Scope == "turn" ? "RESPONSE FAILED" : "FAILURE REPORTED",
            "completed" => item.Evidence?.Scope switch
            {
                "task" => "TASK COMPLETION REPORTED",
                "turn" => "RESPONSE ENDED — TASK OUTCOME UNKNOWN",
                _ => "COMPLETION REPORTED — SCOPE UNKNOWN",
            },
            _ => "UNKNOWN EVENT",
        };
    }

    public static string Details(StateEvent item)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(item.Evidence?.Mechanism)) parts.Add("Via " + item.Evidence.Mechanism);
        parts.Add(item.Evidence?.Basis switch
        {
            "structured_signal" => "Structured signal",
            "explicit_report" => "Explicit report",
            "process_observation" => "Process observation",
            _ => "Evidence not recorded",
        });
        if (!string.IsNullOrWhiteSpace(item.Evidence?.Scope)) parts.Add("Scope: " + item.Evidence.Scope);
        if (!string.IsNullOrWhiteSpace(item.SourceEvent)) parts.Add("Source: " + item.SourceEvent);
        if (!string.IsNullOrWhiteSpace(item.SessionId)) parts.Add("Session: " + item.SessionId);
        if (!string.IsNullOrWhiteSpace(item.TaskId)) parts.Add("Task: " + item.TaskId);
        return string.Join(" · ", parts);
    }

    // Unread action requests first; preserve chronology within each group. Read state is not task resolution.
    public static IEnumerable<StateEvent> Order(IEnumerable<StateEvent> events) => events
        .OrderBy(e => e.Read ? 2 : e.Type is "permission_required" or "input_required" ? 0 : 1)
        .ThenByDescending(e => e.Timestamp);
}
