using System.Runtime.InteropServices;

namespace AgentAttention.UI;

internal static class NativeMethods
{
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr handle);
}
