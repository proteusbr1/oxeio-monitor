using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

[SupportedOSPlatform("windows")]
internal static partial class Wtsapi32
{
    /// <summary>
    /// Careful: an HWND is required; a process without a window will not get lock/unlock events.
    /// Careful: called at boot before Terminal Services has been created, it returns
    /// RPC_S_INVALID_BINDING (1702). The agent then looks healthy, but not a single lock event
    /// arrives during the whole session.
    /// </summary>
    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool WTSRegisterSessionNotification(nint hWnd, uint dwFlags);

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool WTSUnRegisterSessionNotification(nint hWnd);

    /// <summary>
    /// Whether it is locked right now, without waiting for an event. The only reliable way to know
    /// when the agent starts up.
    /// </summary>
    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool WTSQuerySessionInformation(
        nint hServer, uint sessionId, int wtsInfoClass, out nint ppBuffer, out uint pBytesReturned);

    [LibraryImport("wtsapi32.dll")]
    internal static partial void WTSFreeMemory(nint pMemory);
}
