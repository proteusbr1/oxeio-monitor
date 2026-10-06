using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform;

/// <summary>
/// If the agent mistakenly runs in Session 0 (as a Windows Service), <c>GetLastInputInfo</c> keeps
/// growing from boot, so every staff member would show as "idle" forever, while the agent runs
/// happily and sends reports.
///
/// To prevent this silent disaster, it is checked right at the start: if in the wrong session, time
/// is not counted at all.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class SessionGuard
{
    internal readonly record struct Result(
        bool CanTrack,
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
                "Running in Session 0 — no input or desktop is visible from here. " +
                "The agent must run in a user session (Task Scheduler → At log on).");
        }

        return new Result(true, sessionId, console,
            sessionId == console
                ? "Running in the console session"
                : "Running in a non-console session (probably RDP)");
    }
}
