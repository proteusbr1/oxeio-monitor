using System.Diagnostics;
using System.Runtime.Versioning;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// Looking at, killing and starting the agent process. No method throws: if an exception
/// escaped from the watchdog's loop the guard itself would die, and nobody on the machine
/// would be left watching anyone.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class AgentProcess
{
    /// <summary>
    /// Whether our agent is really running at that pid.
    ///
    /// The name check is mandatory. Windows reuses pids, and the pid in the heartbeat file can
    /// be several minutes old. Looking only at "something is running at this pid", the
    /// watchdog would one day kill <c>explorer.exe</c>.
    /// </summary>
    public static bool IsAlive(int pid)
    {
        if (pid <= 0) return false;

        try
        {
            using var process = Process.GetProcessById(pid);
            return string.Equals(
                process.ProcessName, AgentPaths.AgentProcessName, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            // ArgumentException = nothing at that pid. InvalidOperationException = it died
            // midway. Win32Exception = another user's process, could not be opened.
            // All three mean "we cannot see it", so it will not be killed.
            return false;
        }
    }

    /// <summary>
    /// Kills a wedged agent and checks that it really died.
    ///
    /// No attempt is made to send a polite signal, deliberately: we only get here because the
    /// process has not responded for 2 minutes. A loop that cannot write a heartbeat cannot
    /// read any event either.
    ///
    /// A hard kill is safe because the outbox is crash-tolerant by design: rows stay on disk,
    /// when a lease expires <c>ReclaimExpiredLeasesAsync</c> brings them back, and since every
    /// record has a ClientUuid, sending twice does no harm. The worst loss is that a batch
    /// that was midway has to be sent again.
    /// </summary>
    public static bool TryKill(int pid, TimeSpan waitFor, out string detail)
    {
        try
        {
            using var process = Process.GetProcessById(pid);

            if (!string.Equals(
                    process.ProcessName, AgentPaths.AgentProcessName, StringComparison.OrdinalIgnoreCase))
            {
                detail = $"pid {pid} is not our agent ({process.ProcessName}) — left untouched";
                return false;
            }

            process.Kill(entireProcessTree: false);

            // Without waiting, the next step would start a new agent while the dying old one
            // still holds agent.lock: the new one would exit at once and the ladder would count
            // that as a failure. After a few of those it would reach the give-up state, when in
            // fact nothing was broken.
            if (!process.WaitForExit((int)waitFor.TotalMilliseconds))
            {
                detail = $"pid {pid} did not die within {waitFor.TotalSeconds:F0} seconds of being killed";
                return false;
            }

            detail = $"pid {pid} was stopped";
            return true;
        }
        catch (Exception ex)
        {
            detail = $"pid {pid} could not be killed: {ex.GetType().Name} — {ex.Message}";
            return false;
        }
    }

    public static bool TryStart(string exePath, out int pid, out string detail)
    {
        pid = 0;

        try
        {
            var info = new ProcessStartInfo(exePath)
            {
                // With ShellExecute the process would be a child of explorer.exe, not ours,
                // and then getting the pid back would also be uncertain.
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory,
            };

            using var started = Process.Start(info);
            if (started is null)
            {
                detail = "Process.Start returned nothing";
                return false;
            }

            pid = started.Id;
            detail = $"pid {pid} started";
            return true;
        }
        catch (Exception ex)
        {
            detail = $"Could not start it: {ex.GetType().Name} — {ex.Message}";
            return false;
        }
    }
}
