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

    // ── resource telemetry (ResourceProbe) ───────────────────────────────

    /// <summary>
    /// The pseudo-handle <c>-1</c>: "this process". Careful: it is not a real handle and must
    /// <b>not</b> be closed; it costs nothing, which is exactly why a handle counter can use it
    /// without changing the number it measures.
    /// </summary>
    [LibraryImport("kernel32.dll")]
    internal static partial nint GetCurrentProcess();

    /// <summary>
    /// Careful: used instead of <c>Process.HandleCount</c>. That property fills a whole
    /// <c>ProcessInfo</c> through <c>NtQuerySystemInformation</c>, a snapshot of <b>every</b>
    /// process on the machine, allocated anew on each call. Once a minute for days, the probe
    /// meant to catch a leak would itself churn the heap.
    /// </summary>
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetProcessHandleCount(nint hProcess, out uint pdwHandleCount);

    /// <summary>
    /// The <c>K32</c> export in kernel32 (Windows 7+), not <c>psapi.dll</c>: one less DLL loaded
    /// into a process whose module list we are about to inspect.
    ///
    /// Careful: <c>cb</c> must be the size of the <b>_EX</b> struct; with the plain size the call
    /// still succeeds but <c>PrivateUsage</c> stays zero, and "0 bytes" would read as healthy.
    /// </summary>
    [LibraryImport("kernel32.dll", EntryPoint = "K32GetProcessMemoryInfo", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetProcessMemoryInfo(
        nint hProcess, out PROCESS_MEMORY_COUNTERS_EX ppsmemCounters, uint cb);

    /// <summary>
    /// Is this DLL loaded in our process? Non-zero = yes.
    ///
    /// Careful: <c>GetModuleHandleW</c>, not <c>LoadLibrary</c>: it does <b>not</b> add a
    /// reference, so the returned handle is not freed and asking does not keep the DLL alive.
    /// <c>Process.Modules</c> was not used either: it enumerates through a toolhelp snapshot and
    /// builds a <c>ProcessModule</c> object per DLL (~150 in this process) to answer one yes/no.
    /// </summary>
    [LibraryImport("kernel32.dll", EntryPoint = "GetModuleHandleW", StringMarshalling = StringMarshalling.Utf16)]
    internal static partial nint GetModuleHandle(string lpModuleName);
}
