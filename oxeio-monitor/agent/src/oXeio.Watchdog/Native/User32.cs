using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Watchdog.Native;

[SupportedOSPlatform("windows")]
internal static partial class User32
{
    /// <summary>Whether the current session is shutting down / logging off.</summary>
    private const int SM_SHUTTINGDOWN = 0x2000;

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int nIndex);

    /// <summary>
    /// The cheapest way to detect shutdown: no window, no message pump, no
    /// <c>WM_QUERYENDSESSION</c> handler needed.
    ///
    /// Why needed: at shutdown Windows kills the agent. Treating that as a crash and starting a
    /// new process would (a) waste a step of the ladder for nothing, (b) let the new process
    /// block the shutdown and leave the machine hanging on the "Windows is shutting down"
    /// screen, and (c) make the watchdog start the next boot one step behind.
    /// </summary>
    internal static bool IsShuttingDown() => GetSystemMetrics(SM_SHUTTINGDOWN) != 0;
}
