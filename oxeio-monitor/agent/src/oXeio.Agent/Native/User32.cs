using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

[SupportedOSPlatform("windows")]
internal static partial class User32
{
    /// <summary>
    /// Careful: <b>session-based.</b> Called from Session 0 (a Windows Service) it gives wrong
    /// results, which is why the agent must run in the user session (06-Research section 2.2).
    /// Careful: unless <c>plii.cbSize</c> = 8 is passed, it returns false and dwTime stays zero.
    /// </summary>
    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetLastInputInfo(ref LASTINPUTINFO plii);

    /// <summary>
    /// The real way to receive suspend notifications in Modern standby. If not registered, Windows
    /// no longer sends the broadcast for free, and then sleep is not detected.
    /// </summary>
    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial nint RegisterSuspendResumeNotification(nint hRecipient, uint flags);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UnregisterSuspendResumeNotification(nint handle);

    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial nint RegisterPowerSettingNotification(
        nint hRecipient, in Guid powerSettingGuid, uint flags);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UnregisterPowerSettingNotification(nint handle);

    [LibraryImport("user32.dll")]
    internal static partial nint GetForegroundWindow();

    /// <summary>
    /// The window's title. Careful: the return value is the number of characters written; 0 means
    /// the title is empty **or** the call failed. The two cannot be told apart, so both are treated
    /// as "no title".
    /// </summary>
    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextW", SetLastError = true)]
    internal static unsafe partial int GetWindowText(nint hWnd, char* lpString, int nMaxCount);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextLengthW", SetLastError = true)]
    internal static partial int GetWindowTextLength(nint hWnd);

    /// <summary>The window's owner process. The return value is the thread id, which is not needed
    /// here.</summary>
    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial uint GetWindowThreadProcessId(nint hWnd, out uint lpdwProcessId);

    // ── Monitors and capture ─────────────────────────────────────────────

    /// <summary>
    /// Careful: called afresh for every capture, not cached. <c>Screen.AllScreens</c> is not used:
    /// it keeps the bounds from when it was created and gives wrong sizes in mixed-DPI setups. When
    /// docking/undocking or plugging/unplugging a monitor, capturing from an old list would produce
    /// black images.
    /// </summary>
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static unsafe partial bool EnumDisplayMonitors(
        nint hdc, nint lprcClip,
        delegate* unmanaged[Stdcall]<nint, nint, RECT*, nint, int> lpfnEnum,
        nint dwData);

    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetMonitorInfo(nint hMonitor, ref MONITORINFOEXW lpmi);

    [LibraryImport("user32.dll")]
    internal static partial nint GetDC(nint hWnd);

    [LibraryImport("user32.dll")]
    internal static partial int ReleaseDC(nint hWnd, nint hDC);

    /// <summary>So the agent does not capture its own window.</summary>
    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetWindowDisplayAffinity(nint hWnd, uint dwAffinity);

    /// <summary>To check for GDI/USER handle leaks (0 = GDI, 1 = USER).</summary>
    [LibraryImport("user32.dll")]
    internal static partial uint GetGuiResources(nint hProcess, uint uiFlags);
}
