using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Watchdog.Native;

/// <summary>
/// Exactly the Win32 the watchdog needs, and no more.
/// This was copied from oXeio.Agent's Native/, not referenced: there must be no compile-time
/// link between the guard and the process being guarded.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class Kernel32
{
    /// <summary>
    /// Does <b>not count</b> sleep time, in 100-nanosecond units.
    ///
    /// This, not <c>GetTickCount64</c>, is what measures the heartbeat's age. GetTickCount64
    /// counts sleep time too, so a laptop that slept overnight would show an 8-hour-stale
    /// heartbeat on waking, and a healthy agent would be killed the second it woke.
    /// </summary>
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool QueryUnbiasedInterruptTime(out ulong unbiasedTime);

    [LibraryImport("kernel32.dll")]
    internal static partial uint GetCurrentProcessId();

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ProcessIdToSessionId(uint dwProcessId, out uint pSessionId);

    /// <summary>Which session is on the physical console now. 0xFFFFFFFF if nobody is logged on.</summary>
    [LibraryImport("kernel32.dll")]
    internal static partial uint WTSGetActiveConsoleSessionId();

    internal const uint InvalidSessionId = 0xFFFF_FFFFu;

    /// <summary>
    /// In the one-shot CLI mode (<c>--install-task</c>), so that the output is visible in the
    /// elevated prompt. A WinExe has no console of its own, so it attaches to the parent's.
    /// It must be called before the first use of <c>Console</c>: once .NET has taken the
    /// handle it does not change later.
    /// </summary>
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool AttachConsole(uint dwProcessId);

    internal const uint AttachParentProcess = 0xFFFF_FFFFu;

    /// <summary>
    /// The unbiased clock in milliseconds. <c>null</c> if it cannot be read.
    ///
    /// On failure it must not return 0 or -1. 0 means "the moment of boot", so every heartbeat
    /// would look like it is "in the future", all agents would be taken as wedged, and the
    /// whole fleet would restart at once. With null the caller skips the whole tick.
    /// </summary>
    internal static long? UnbiasedMs() =>
        QueryUnbiasedInterruptTime(out var ticks) ? (long)(ticks / 10_000UL) : null;
}
