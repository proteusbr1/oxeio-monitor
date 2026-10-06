using System.Diagnostics;
using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Watchdog;

namespace oXeio.Agent.Platform;

/// <summary>
/// The agent is alive: this is the only way to tell the watchdog so.
///
/// Two things, two separate jobs:
/// <list type="bullet">
/// <item><b><c>agent.lock</c></b>: an exclusive file lock, held for the process's whole life. It
/// <b>prevents</b> two agents running on one machine.</item>
/// <item><b><c>agent.alive</c></b>: written every 15 seconds. The only way to catch a process that
/// is alive but <b>stuck</b>.</item>
/// </list>
///
/// <b>What happened without this:</b> after install and start, the watchdog saw nobody holding
/// <c>agent.lock</c>, thought the agent had died, and <b>started another agent</b>. Again after 30
/// seconds. Two agents counted the same hour twice, and from the server's side that looked like
/// nothing but "someone is working very hard" ([G57](../../../../docs/history/08-Gap-Analysis.md)).
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class LivenessBeacon : IDisposable
{
    private readonly string _heartbeatPath;
    private readonly FileStream _lock;
    private readonly uint _sessionId;
    private readonly CancellationTokenSource _stopping = new();

    private LivenessBeacon(FileStream held, string heartbeatPath, uint sessionId)
    {
        _lock = held;
        _heartbeatPath = heartbeatPath;
        _sessionId = sessionId;
    }

    /// <summary>
    /// Try to take the lock. <b>If not obtained, <c>null</c></b>: another agent is already running
    /// on this machine, and then this process should stop.
    /// </summary>
    public static LivenessBeacon? TryAcquire(string dataDirectory)
    {
        var lockPath = Path.Combine(dataDirectory, AgentLiveness.AgentLockFileName);

        try
        {
            // Careful: FileShare.None is the foundation of the whole scheme. The watchdog fails
            // when it tries to open the same file, and that failure is how it learns that "the
            // agent is running".
            var held = new FileStream(
                lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);

            Kernel32.ProcessIdToSessionId((uint)Environment.ProcessId, out var session);

            return new LivenessBeacon(
                held,
                Path.Combine(dataDirectory, AgentLiveness.HeartbeatFileName),
                session);
        }
        catch (IOException)
        {
            // someone else is holding it: normal, not an exception
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Starts writing the heartbeat every 15 seconds in the background. The first one immediately,
    /// so the watchdog's first 30-second check finds it.
    /// </summary>
    public void Start()
    {
        _ = Task.Run(async () =>
        {
            while (!_stopping.IsCancellationRequested)
            {
                Write();

                try { await Task.Delay(AgentLiveness.HeartbeatInterval, _stopping.Token); }
                catch (OperationCanceledException) { return; }
            }
        });
    }

    private void Write()
    {
        try
        {
            Kernel32.QueryUnbiasedInterruptTime(out var unbiased);

            var beat = new AgentHeartbeat
            {
                Version = AgentLiveness.CurrentVersion,
                ProcessId = Environment.ProcessId,
                SessionId = _sessionId,

                // Careful: unbiased clock, which does not count time asleep. After a PC woke from
                // sleep, a biased clock would make the heartbeat look "10 hours old" and the
                // watchdog would kill a healthy agent.
                UnbiasedMs = (long)(unbiased / 10_000),

                WrittenAtUtc = DateTimeOffset.UtcNow,
            };

            // Careful: write to temp first, then move. If the watchdog read a half-written line,
            // parsing would fail, which is the same as "no heartbeat".
            var temp = _heartbeatPath + ".tmp";
            File.WriteAllText(temp, AgentLiveness.Format(beat));
            File.Move(temp, _heartbeatPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Missing one heartbeat is not serious: it takes 120 seconds to go stale, i.e. only
            // after 8 misses in a row.
            Debug.WriteLine($"could not write the heartbeat: {ex.Message}");
        }
    }

    public void Dispose()
    {
        _stopping.Cancel();
        _lock.Dispose();
        _stopping.Dispose();

        // Careful: the heartbeat file is deleted. Otherwise even after the agent stopped, the
        // watchdog would think it was alive for 120 seconds, and nothing would be tracked in that
        // time.
        try { File.Delete(_heartbeatPath); }
        catch (Exception) { /* shutting down; nothing more to do */ }
    }
}
