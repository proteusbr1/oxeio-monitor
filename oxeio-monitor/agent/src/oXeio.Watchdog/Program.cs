using System.Runtime.Versioning;

using oXeio.Core.Watchdog;
using oXeio.Watchdog.Deployment;
using oXeio.Watchdog.Native;
using oXeio.Watchdog.Platform;

namespace oXeio.Watchdog;

/// <summary>
/// Watchdog for the oXeio agent (H01). No UI, no window, just a loop.
///
/// <b>Usage</b>
/// <code>
/// oXeio.Watchdog.exe                      start supervising (how Task Scheduler runs it)
/// oXeio.Watchdog.exe --install-task       H02: install the logon task (needs admin)
/// oXeio.Watchdog.exe --uninstall-task     remove the task
/// oXeio.Watchdog.exe --print-task-xml     print the task XML (changes nothing)
/// oXeio.Watchdog.exe --agent &lt;path&gt;      when the agent exe is somewhere else
/// oXeio.Watchdog.exe --data &lt;dir&gt;        a folder other than %ProgramData%\oXeio
/// </code>
///
/// Exit codes: 0 normal; 1 cannot supervise in this session; 2 another watchdog is
/// already running; 3 could not create the data folder; 4 could not install the task.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Program
{
    private static int Main(string[] args)
    {
        var agentPath = ValueOf(args, "--agent");
        var dataDir = ValueOf(args, "--data");

        if (Has(args, "--install-task") || Has(args, "--uninstall-task") || Has(args, "--print-task-xml"))
            return RunOneShot(args);

        return Supervise(dataDir, agentPath);
    }

    // ── supervising ─────────────────────────────────────────────────────────

    private static int Supervise(string? dataDir, string? agentPath)
    {
        var paths = dataDir is null ? AgentPaths.Default : new AgentPaths(dataDir);

        if (!paths.EnsureDirectory())
        {
            // There is nowhere to write the log, so nothing can be logged; the exit
            // code is the only signal. The installer must give the Users group Modify
            // on %ProgramData%\oXeio (see the comment in AgentPaths).
            return 3;
        }

        var log = new RollingLog(paths.Log);

        // Careful: in Session 0 we stop right here. Every agent started from there
        // would be shut down immediately, so the watchdog would become a machine for
        // creating processes that are certain to fail.
        var session = SessionCheck.Check();
        if (session.SessionId == 0)
        {
            log.Write($"❌ {session.Explanation}");
            return 1;
        }

        log.Write($"Session {session.SessionId} (console {session.ConsoleSessionId}) — {session.Explanation}");

        // Careful: with two watchdogs, each would see the other's agent as "unknown"
        // and interfere, and their two separate ladders would double the restart storm.
        // Task Scheduler's IgnoreNew is the first barrier; this is the second, certain one.
        using var self = InstanceLock.TryAcquire(paths.WatchdogLock);
        if (self is null)
        {
            log.Write("⚠️ Another watchdog is already running — this one is exiting");
            return 2;
        }

        using var stop = new ManualResetEvent(false);

        // So that the last line can still be written on Windows shutdown or when the task is
        // stopped.
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try { stop.Set(); } catch (ObjectDisposedException) { }
        };

        new WatchdogLoop(paths, log, agentPath).Run(stop, AgentLiveness.CheckInterval);
        return 0;
    }

    // ── one-shot CLI ────────────────────────────────────────────────────────

    private static int RunOneShot(string[] args)
    {
        // A WinExe has no console of its own. When an admin runs this from an elevated
        // prompt, the output is shown there. Careful: must be called before the first Console use.
        Kernel32.AttachConsole(Kernel32.AttachParentProcess);

        var output = Console.Out;
        var exe = Path.Combine(AppContext.BaseDirectory, "oXeio.Watchdog.exe");

        if (Has(args, "--print-task-xml"))
        {
            output.WriteLine(TaskInstaller.RenderXml(exe));
            return 0;
        }

        if (Has(args, "--uninstall-task"))
            return TaskInstaller.Uninstall(output);

        return TaskInstaller.Install(exe, output);
    }

    // ── small helpers ───────────────────────────────────────────────────────

    private static bool Has(string[] args, string flag) =>
        Array.Exists(args, a => string.Equals(a, flag, StringComparison.OrdinalIgnoreCase));

    /// <summary>The value from a <c>--name value</c> pair, or null if absent.</summary>
    private static string? ValueOf(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }

        return null;
    }
}
