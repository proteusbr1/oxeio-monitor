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
}
