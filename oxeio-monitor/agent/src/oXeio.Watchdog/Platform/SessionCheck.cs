using System.Runtime.Versioning;

using oXeio.Watchdog.Native;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// The part of <c>oXeio.Agent/Platform/SessionGuard.cs</c> that the watchdog needs,
/// rewritten. Careful: it is copied, not referenced; the watchdog must not depend on
/// oXeio.Agent.
///
/// For the agent the question was "can I see input?". For the watchdog the question is
/// different and sharper:
///
/// <b>A child started with <c>Process.Start</c> from Session 0 is also born in
/// Session 0.</b> There the agent's own SessionGuard shuts it down immediately
/// (exit 1). So the watchdog would keep creating a process that is certain to fail:
/// the perfect recipe for a restart storm, on 15 PCs at once. So when in the wrong
/// session the watchdog does nothing except log.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class SessionCheck
{
    internal readonly record struct Result(
        bool CanSupervise,
        uint SessionId,
        uint ConsoleSessionId,
        string Explanation);

    public static Result Check()
    {
        if (!Kernel32.ProcessIdToSessionId(Kernel32.GetCurrentProcessId(), out var sessionId))
            return new Result(false, 0, 0, "Could not determine the session id");

        var console = Kernel32.WTSGetActiveConsoleSessionId();

        if (sessionId == 0)
        {
            return new Result(false, sessionId, console,
                "Running in Session 0 — an agent started from here would also land in Session 0 " +
                "and stop immediately. The watchdog must run in a user session " +
                "(Task Scheduler → At log on)।");
        }

        // Nobody is on the console (mid logoff, or fast user switching). The agent
        // being absent is legitimate here, not a failure. We look again next tick.
        if (console == Kernel32.InvalidSessionId)
        {
            return new Result(false, sessionId, console,
                "There is no session on the console — mid logon/logoff, nothing is done on this tick");
        }

        return new Result(true, sessionId, console,
            sessionId == console
                ? "Running in the console session"
                : "Running in a non-console session (probably RDP)");
    }
}
