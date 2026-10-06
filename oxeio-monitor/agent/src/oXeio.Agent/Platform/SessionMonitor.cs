using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Agent;

namespace oXeio.Agent.Platform;

/// <summary>
/// lock / unlock / logon / logoff / RDP disconnect.
///
/// Careful: catching only Win+L is not enough. Fast user switching and RDP disconnect, the two most
/// common ways of walking away from a shared or remote PC, never produce SESSION_LOCK. They must be
/// caught separately, otherwise the clock keeps running.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class SessionMonitor : IDisposable
{
    private readonly nint _hwnd;
    private bool _registered;

    /// <summary>The events on which tracking stops.</summary>
    private static readonly HashSet<int> Suspending =
    [
        Win32.WTS_SESSION_LOCK,
        Win32.WTS_SESSION_LOGOFF,
        Win32.WTS_SESSION_TERMINATE,
        Win32.WTS_CONSOLE_DISCONNECT,
        Win32.WTS_REMOTE_DISCONNECT,
    ];

    /// <summary>The events on which it starts again.</summary>
    private static readonly HashSet<int> Resuming =
    [
        Win32.WTS_SESSION_UNLOCK,
        Win32.WTS_SESSION_LOGON,
        Win32.WTS_CONSOLE_CONNECT,
        Win32.WTS_REMOTE_CONNECT,
    ];

    public SessionMonitor(nint hwnd) => _hwnd = hwnd;

    /// <summary>Returns what happened if registration fails: it does not stay silent.</summary>
    public (bool Ok, int Error) TryRegister()
    {
        if (Wtsapi32.WTSRegisterSessionNotification(_hwnd, Win32.NOTIFY_FOR_THIS_SESSION))
        {
            _registered = true;
            return (true, 0);
        }

        return (false, Marshal.GetLastPInvokeError());
    }

    public static SessionChange? Interpret(int wtsCode) =>
        Suspending.Contains(wtsCode) ? SessionChange.Suspend
        : Resuming.Contains(wtsCode) ? SessionChange.Resume
        : null;

    /// <summary>
    /// G02: does this session message mean "the staff member is leaving"? If so, the event type to
    /// send, otherwise <c>null</c>.
    ///
    /// Careful: <b>lock is not here, deliberately.</b> Locking does not mean leaving: in eight
    /// straight hours one person locks a dozen times. Sending those as events would fill
    /// <c>agent_events</c> with about a thousand rows a day, while for the hours calculation a lock
    /// already becomes a <see cref="oXeio.Core.Models.SegmentState.Locked"/> segment, so the
    /// information would be stored twice.
    ///
    /// Careful: <c>WTS_SESSION_TERMINATE</c> is also a logoff. The session was ended from outside
    /// (admin, timeout); from the staff member's side the result is the same, and without sending
    /// the event the server would treat that <c>agent_stop</c> as interference.
    /// </summary>
    public static string? ClosingEventType(int wtsCode) => wtsCode switch
    {
        Win32.WTS_SESSION_LOGOFF or Win32.WTS_SESSION_TERMINATE => AgentEventTypes.Logoff,
        _ => null,
    };

    /// <summary>
    /// <c>WM_ENDSESSION</c> to <c>logoff</c> / <c>shutdown</c> / nothing.
    ///
    /// <b>Shutdown news does not arrive in PowerMonitor; this was checked.</b> All forms of
    /// <c>WM_POWERBROADCAST</c> (<c>PBT_APMSUSPEND</c>, <c>PBT_APMRESUME*</c>, display) speak of
    /// sleep and wake; when Windows shuts down or restarts, none of them arrives. Shutdown comes
    /// <b>only</b> as <c>WM_QUERYENDSESSION</c>/<c>WM_ENDSESSION</c>, and that is a session
    /// message, which is why the interpretation is here and not in the power code. Putting it in
    /// PowerMonitor would compile and run, and the <c>shutdown</c> event would never go out.
    ///
    /// Careful: both WTS's logoff and the logoff here arrive. Only one is sent; the dedup is in
    /// <c>AgentHost</c> (<c>RaiseClosingEvent</c>).
    /// </summary>
    /// <param name="wParam">0 means the session is not actually ending (someone said "no").</param>
    /// <param name="lParam">The ENDSESSION_* bitmask.</param>
    public static string? InterpretEndSession(nint wParam, nint lParam)
    {
        // wParam == FALSE means someone blocked it in WM_QUERYENDSESSION and the session will go
        // on. Sending an event here would leave a false "PC shut down" record.
        if (wParam == 0) return null;

        // Careful: on 64-bit lParam may be sign-extended; the low 32 bits are the real value.
        var flags = unchecked((uint)(long)lParam);

        if ((flags & Win32.ENDSESSION_LOGOFF) != 0) return AgentEventTypes.Logoff;

        /*
         * Careful: CLOSEAPP alone means Restart Manager is closing us (usually to install an
         * update), not that the PC is shutting down. It cannot be called `shutdown`: every agent
         * update would otherwise leave a fake "PC shut down" record.
         *
         * Careful: **but this used to return `null`, and that was a silent bug.** `null` means no
         * closing event goes out, yet `agent_stop` does, and the server's G02 treats an
         * `agent_stop` with no companion as **interference** (`alerts.rules.ts`, `isTamperStop`).
         * So every update raised a false `agent_killed` alert. Updating one or two PCs by hand went
         * unnoticed; once the rollout started on its own, 12 at a time, and after that nobody read
         * alerts any more.
         *
         * It now has a name of its own (`agent_update`): it tells the truth, and the server treats
         * it as a valid companion of `agent_stop`.
         */
        if ((flags & Win32.ENDSESSION_CLOSEAPP) != 0)
            return AgentEventTypes.AgentUpdate;

        // everything else (0, ENDSESSION_CRITICAL) = the PC is shutting down or restarting
        return AgentEventTypes.Shutdown;
    }

    public static string Describe(int wtsCode) => wtsCode switch
    {
        Win32.WTS_CONSOLE_CONNECT => "console connect",
        Win32.WTS_CONSOLE_DISCONNECT => "console disconnect",
        Win32.WTS_REMOTE_CONNECT => "remote connect",
        Win32.WTS_REMOTE_DISCONNECT => "remote disconnect",
        Win32.WTS_SESSION_LOGON => "logon",
        Win32.WTS_SESSION_LOGOFF => "logoff",
        Win32.WTS_SESSION_LOCK => "lock",
        Win32.WTS_SESSION_UNLOCK => "unlock",
        Win32.WTS_SESSION_TERMINATE => "terminate",
        _ => $"unknown ({wtsCode})",
    };

    public void Dispose()
    {
        if (!_registered) return;
        Wtsapi32.WTSUnRegisterSessionNotification(_hwnd);
        _registered = false;
    }
}

internal enum SessionChange
{
    Suspend,
    Resume,
}
