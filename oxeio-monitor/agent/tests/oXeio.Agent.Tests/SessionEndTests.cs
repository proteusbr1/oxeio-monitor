using oXeio.Agent.Native;
using oXeio.Agent.Platform;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// G02: "staff left" versus "the PC is shutting down".
///
/// This distinction is the whole basis of the server's tamper alert
/// (<c>alerts.rules.ts</c>): if a <c>logoff</c>/<c>shutdown</c> is near an
/// <c>agent_stop</c> it is a normal stop; if not, it is interference. One mistake here
/// means either 15 false alerts a day, or real interference quietly getting away.
/// </summary>
public class SessionEndTests
{
    private static nint Flags(uint value) => unchecked((nint)(long)(int)value);

    // ── WM_ENDSESSION ───────────────────────────────────────────────────────

    [Fact]
    public void The_logoff_bit_gives_logoff() =>
        Assert.Equal(
            AgentEventTypes.Logoff,
            SessionMonitor.InterpretEndSession(1, Flags(Win32.ENDSESSION_LOGOFF)));

    /// <summary>lParam 0 = Windows is shutting down or restarting (MSDN).</summary>
    [Fact]
    public void A_zero_lParam_means_shutdown() =>
        Assert.Equal(AgentEventTypes.Shutdown, SessionMonitor.InterpretEndSession(1, 0));

    /// <summary>
    /// CRITICAL only says "no chance to refuse"; it does not change the kind of stop.
    /// Comparing with <c>==</c> would send this case the wrong way.
    /// </summary>
    [Fact]
    public void Adding_CRITICAL_still_gives_shutdown() =>
        Assert.Equal(
            AgentEventTypes.Shutdown,
            SessionMonitor.InterpretEndSession(1, Flags(Win32.ENDSESSION_CRITICAL)));

    [Fact]
    public void CRITICAL_with_logoff_still_gives_logoff() =>
        Assert.Equal(
            AgentEventTypes.Logoff,
            SessionMonitor.InterpretEndSession(
                1, Flags(Win32.ENDSESSION_CRITICAL | Win32.ENDSESSION_LOGOFF)));

    /// <summary>
    /// <b>Restart Manager is making us stop, and that has a name of its own.</b>
    ///
    /// Careful: this could not be treated as <c>shutdown</c>: every update would leave a
    /// false "PC shut down" record, and the server would get a dozen false shutdowns.
    ///
    /// Careful: <b>this used to return <c>null</c>, which was a silent bug.</b>
    /// <c>null</c> means no closing event is sent at all, yet <c>agent_stop</c> is
    /// still sent, and the server's G02 treats an unpaired <c>agent_stop</c> as
    /// <b>interference</b>. So every update raised a false <c>agent_killed</c> alert.
    ///
    /// Updating one or two PCs by hand would go unnoticed; once the rollout starts on
    /// its own, 12 at a time, and soon nobody would read the alerts.
    /// </summary>
    [Fact]
    public void CLOSEAPP_alone_means_an_update() =>
        Assert.Equal(
            AgentEventTypes.AgentUpdate,
            SessionMonitor.InterpretEndSession(1, Flags(Win32.ENDSESSION_CLOSEAPP)));

    /// <summary>
    /// <b>CLOSEAPP together with LOGOFF is a real logoff</b>, because the bits are not
    /// mutually exclusive. So the order matters: LOGOFF is checked first. The other
    /// way round, a logoff with Restart Manager involved would become an "update" and a
    /// real <c>logoff</c> event would be lost.
    /// </summary>
    [Fact]
    public void CLOSEAPP_together_with_LOGOFF_is_a_logoff() =>
        Assert.Equal(
            AgentEventTypes.Logoff,
            SessionMonitor.InterpretEndSession(
                1, Flags(Win32.ENDSESSION_CLOSEAPP | Win32.ENDSESSION_LOGOFF)));

    /// <summary>
    /// wParam == FALSE means someone vetoed WM_QUERYENDSESSION, so the session goes on.
    /// Sending an event here would wrongly record "PC shut down".
    /// </summary>
    [Fact]
    public void A_cancelled_session_end_sends_nothing() =>
        Assert.Null(SessionMonitor.InterpretEndSession(0, 0));

    // ── WM_WTSSESSION_CHANGE ────────────────────────────────────────────────

    [Theory]
    [InlineData(Win32.WTS_SESSION_LOGOFF)]
    [InlineData(Win32.WTS_SESSION_TERMINATE)]
    public void Session_end_codes_give_logoff(int code) =>
        Assert.Equal(AgentEventTypes.Logoff, SessionMonitor.ClosingEventType(code));

    /// <summary>
    /// Careful: lock/unlock are not events. Someone locks a dozen times a day; sending
    /// them would fill <c>agent_events</c> with thousands of rows daily, though the
    /// information is already in the <c>locked</c> segments.
    /// </summary>
    [Theory]
    [InlineData(Win32.WTS_SESSION_LOCK)]
    [InlineData(Win32.WTS_SESSION_UNLOCK)]
    [InlineData(Win32.WTS_SESSION_LOGON)]
    [InlineData(Win32.WTS_REMOTE_DISCONNECT)]
    public void Other_session_messages_give_no_event(int code) =>
        Assert.Null(SessionMonitor.ClosingEventType(code));

    /// <summary>
    /// Careful: tracking and events are two separate decisions, and both must exist.
    /// On RDP disconnect the clock stops but nobody has "left"; on logoff both happen.
    /// </summary>
    [Fact]
    public void Tracking_stopping_and_leaving_are_not_the_same()
    {
        Assert.Equal(SessionChange.Suspend, SessionMonitor.Interpret(Win32.WTS_REMOTE_DISCONNECT));
        Assert.Null(SessionMonitor.ClosingEventType(Win32.WTS_REMOTE_DISCONNECT));

        Assert.Equal(SessionChange.Suspend, SessionMonitor.Interpret(Win32.WTS_SESSION_LOGOFF));
        Assert.Equal(AgentEventTypes.Logoff, SessionMonitor.ClosingEventType(Win32.WTS_SESSION_LOGOFF));
    }

    /// <summary>A string that matches the server's prisma enum exactly.</summary>
    [Fact]
    public void The_event_names_match_the_servers_names()
    {
        Assert.Equal("logoff", AgentEventTypes.Logoff);
        Assert.Equal("shutdown", AgentEventTypes.Shutdown);
        Assert.Equal("agent_stop", AgentEventTypes.AgentStop);

        /*
         * Careful: this string must be **exactly** in the server's `alerts.rules.ts`
         * `CLEAN_STOP_CONTEXT`. If it differs by one character the pair would never
         * match, and every update would raise a false `agent_killed` alert again,
         * with no error at all.
         */
        Assert.Equal("agent_update", AgentEventTypes.AgentUpdate);
    }
}
