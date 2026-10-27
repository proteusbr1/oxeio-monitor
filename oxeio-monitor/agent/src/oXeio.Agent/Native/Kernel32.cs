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

    // ── Pinning a staged update (UpdateLock) ─────────────────────────────

    internal const uint GENERIC_READ = 0x80000000;
    internal const uint FILE_LIST_DIRECTORY = 0x0001;
    internal const uint FILE_READ_ATTRIBUTES = 0x0080;
    internal const uint FILE_SHARE_READ = 0x1;
    internal const uint FILE_SHARE_WRITE = 0x2;
    internal const uint OPEN_EXISTING = 3;
    internal const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    internal const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    internal const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    internal const uint FILE_NAME_NORMALIZED = 0x0;
    internal const uint VOLUME_NAME_DOS = 0x0;

    /// <summary>
    /// Careful: used instead of <c>File.OpenHandle</c> for two flags .NET does not expose:
    /// <c>FILE_FLAG_BACKUP_SEMANTICS</c> (the only way to get a handle on a <b>directory</b>) and
    /// <c>FILE_FLAG_OPEN_REPARSE_POINT</c> (open a junction or symlink <b>itself</b>, so it can be
    /// seen and refused, instead of silently following it to wherever it points).
    /// </summary>
    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true,
        StringMarshalling = StringMarshalling.Utf16)]
    internal static partial Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        nint lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        nint hTemplateFile);

    /// <summary>The path an open handle really refers to, after every junction and link.</summary>
    [LibraryImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true,
        StringMarshalling = StringMarshalling.Utf16)]
    internal static partial uint GetFinalPathNameByHandle(
        Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
        [Out] char[] lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

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
