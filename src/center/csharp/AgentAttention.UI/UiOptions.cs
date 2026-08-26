using System.Security.Principal;
using System.IO;

namespace AgentAttention.UI;

public sealed class UiOptions
{
    public string StatePath { get; init; } = DefaultFilePath("state.json");
    public string RegistryPath { get; init; } = DefaultFilePath("agents.json");

    public string CliPath { get; init; } = string.Empty;
    public string TrayStatePath { get; init; } = string.Empty;
    public string TrayPidPath { get; init; } = string.Empty;
    public bool OpenCenter { get; init; }

    public string UserToken { get; } = WindowsIdentity.GetCurrent().Name.Replace('\\', '_');

    public string TrayMutexName => $"Local\\agent-attention-tray-{UserToken}";
    public string CenterMutexName => $"Local\\agent-attention-center-{UserToken}";
    public string ActivationEventName => $"Local\\agent-attention-ui-open-center-{UserToken}";

    public static UiOptions Parse(string[] arguments)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var openCenter = false;
        for (var index = 0; index < arguments.Length; index++)
        {
            var name = arguments[index].TrimStart('-');
            if (name.Equals("OpenCenter", StringComparison.OrdinalIgnoreCase))
            {
                openCenter = true;
                continue;
            }

            if (index + 1 >= arguments.Length)
            {
                throw new ArgumentException($"Missing value for {arguments[index]}");
            }

            values[name] = arguments[index + 1];
            index++;
        }

        return new UiOptions
        {
            StatePath = GetValue(values, "StatePath", DefaultFilePath("state.json")),
            RegistryPath = GetValue(values, "RegistryPath", DefaultFilePath("agents.json")),
            CliPath = GetValue(values, "CliPath", string.Empty),
            TrayStatePath = GetValue(values, "TrayStatePath", string.Empty),
            TrayPidPath = GetValue(values, "TrayPidPath", string.Empty),
            OpenCenter = openCenter,
        };
    }

    private static string GetValue(IReadOnlyDictionary<string,string> values,string name,string fallback)
    {
        return values.TryGetValue(name,out var value)&&!string.IsNullOrWhiteSpace(value)?value:fallback;
    }

    private static string DefaultFilePath(string fileName)
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".agent-attention",
            fileName);
    }
}
