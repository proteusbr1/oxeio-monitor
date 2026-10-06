using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform;

/// <summary>
/// Whether the manifest's PerMonitorV2 has really taken effect.
///
/// If not, no error shows: a 4K monitor at 150% scale would just report itself as 2560x1440 and
/// Windows would give shrunken frames. Every screenshot would then be soft, and text of 9-10 points
/// unreadable, although reading that text is the very purpose of the screenshot.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class DpiGuard
{
    internal readonly record struct Result(bool Ok, ProcessDpiAwareness Awareness);

    public static Result Check()
    {
        if (Shcore.GetProcessDpiAwareness(0, out var awareness) != 0)
            return new Result(false, ProcessDpiAwareness.Unaware);

        return new Result(awareness == ProcessDpiAwareness.PerMonitorDpiAware, awareness);
    }
}
