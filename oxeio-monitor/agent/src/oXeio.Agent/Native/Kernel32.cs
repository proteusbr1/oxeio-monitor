using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

[SupportedOSPlatform("windows")]
internal static partial class Kernel32
{
    /// <summary>
    /// Also counts the time spent asleep. <c>GetLastInputInfo.dwTime</c> runs on exactly this
    /// clock, so this is what must be used for the subtraction.
    ///
    /// Careful: <c>Environment.TickCount64</c> must not be used. On .NET 8 it equals this, but if a
    /// later .NET version changes it to an unbiased clock, the subtraction against dwTime would
    /// silently be wrong, with no code change, just a framework upgrade. Hence the direct P/Invoke.
    /// </summary>
    [LibraryImport("kernel32.dll")]
    internal static partial ulong GetTickCount64();

    /// <summary>Does not count time spent asleep. In units of 100 nanoseconds.</summary>
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool QueryUnbiasedInterruptTime(out ulong unbiasedTime);

    [LibraryImport("kernel32.dll")]
    internal static partial uint GetCurrentProcessId();

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

    [LibraryImport("kernel32.dll")]
    internal static partial uint WTSGetActiveConsoleSessionId();
}
