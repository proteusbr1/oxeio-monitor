namespace oXeio.Agent.Native;

/// <summary>
/// All constants in one place, so that no magic numbers sit at call sites. If any of these were
/// copied wrongly, the bug would be silent (it compiles, runs, and gives wrong results).
/// </summary>
internal static class Win32
{
    // ── Window messages ──────────────────────────────────────────────────
    internal const int WM_WTSSESSION_CHANGE = 0x02B1;
    internal const int WM_POWERBROADCAST = 0x0218;
    internal const int WM_QUERYENDSESSION = 0x0011;
    internal const int WM_ENDSESSION = 0x0016;
    internal const int WM_DISPLAYCHANGE = 0x007E;
    internal const int WM_TIMECHANGE = 0x001E;

    // ── Session notifications ────────────────────────────────────────────
    internal const uint NOTIFY_FOR_THIS_SESSION = 0x0;

    internal const int WTS_CONSOLE_CONNECT = 0x1;
    internal const int WTS_CONSOLE_DISCONNECT = 0x2;
    internal const int WTS_REMOTE_CONNECT = 0x3;
    internal const int WTS_REMOTE_DISCONNECT = 0x4;
    internal const int WTS_SESSION_LOGON = 0x5;
    internal const int WTS_SESSION_LOGOFF = 0x6;
    internal const int WTS_SESSION_LOCK = 0x7;
    internal const int WTS_SESSION_UNLOCK = 0x8;
    internal const int WTS_SESSION_TERMINATE = 0xB;

    // ── Session end (lParam of WM_ENDSESSION) ─────────────────────────────
    // Careful: these three are bitmasks, not mutually exclusive values. Comparing with <c>==</c>
    // would turn a logoff that arrives with ENDSESSION_CRITICAL into "shutdown".

    /// <summary>If set, the user is logging off; <b>if not set</b>, the PC is shutting
    /// down/restarting.</summary>
    internal const uint ENDSESSION_LOGOFF = 0x80000000;

    /// <summary>Restart Manager is closing the app (to replace files): not a session end.</summary>
    internal const uint ENDSESSION_CLOSEAPP = 0x00000001;

    /// <summary>Forced: no chance to say "no". It does not change the kind of shutdown.</summary>
    internal const uint ENDSESSION_CRITICAL = 0x40000000;

    internal const int WTSSessionInfoEx = 25;
    internal const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;

    // Careful: LOCK's value is smaller than UNLOCK's; getting it backwards would invert the whole
    // calculation
    internal const int WTS_SESSIONSTATE_UNKNOWN = -1;
    internal const int WTS_SESSIONSTATE_LOCK = 0;
    internal const int WTS_SESSIONSTATE_UNLOCK = 1;

    // ── Power ────────────────────────────────────────────────────────────
    internal const int PBT_APMSUSPEND = 0x0004;
    internal const int PBT_APMRESUMESUSPEND = 0x0007;

    /// <summary>What Windows guarantees, yet .NET's SystemEvents does not catch exactly
    /// this.</summary>
    internal const int PBT_APMRESUMEAUTOMATIC = 0x0012;
    internal const int PBT_POWERSETTINGCHANGE = 0x8013;

    internal const uint DEVICE_NOTIFY_WINDOW_HANDLE = 0x0;

    /// <summary>The display turning off: the earliest signal of entering Modern standby.</summary>
    internal static readonly Guid GUID_SESSION_DISPLAY_STATUS =
        new("2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5");

    internal const int MONITOR_DISPLAY_OFF = 0;
    internal const int MONITOR_DISPLAY_ON = 1;
    internal const int MONITOR_DISPLAY_DIM = 2;

    // ── Window styles ─────────────────────────────────────────────────────
    // Careful: an HWND_MESSAGE (message-only) window does not receive broadcast messages. So even
    // if hidden, a top-level window must be created.
    internal const int WS_POPUP = unchecked((int)0x80000000);
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int WS_EX_NOACTIVATE = 0x08000000;

    // ── Error codes ──────────────────────────────────────────────────────
    internal const int ERROR_INVALID_PARAMETER = 87;

    /// <summary>When registering at boot before Terminal Services has been created.</summary>
    internal const int RPC_S_INVALID_BINDING = 1702;
}
