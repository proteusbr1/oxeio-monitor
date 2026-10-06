using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

internal enum ProcessDpiAwareness
{
    Unaware = 0,
    SystemDpiAware = 1,
    PerMonitorDpiAware = 2,
}

[SupportedOSPlatform("windows")]
internal static partial class Shcore
{
    internal const int MDT_EFFECTIVE_DPI = 0;

    [LibraryImport("shcore.dll")]
    internal static partial int GetDpiForMonitor(
        nint hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    /// <summary>
    /// To verify that the manifest's DPI setting has really taken effect. If it has not, the image
    /// of a 4K monitor at 150% scale would be shrunk and the text unreadable, with no exception or
    /// error showing.
    /// </summary>
    [LibraryImport("shcore.dll")]
    internal static partial int GetProcessDpiAwareness(nint hprocess, out ProcessDpiAwareness value);
}
