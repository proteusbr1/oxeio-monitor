using System.Globalization;
using System.Runtime.Versioning;

using oXeio.Core.Time;
using oXeio.Core.Watchdog;
using oXeio.Watchdog.Native;
using oXeio.Watchdog.Platform;

namespace oXeio.Watchdog;

/// <summary>
/// The 30-second loop: observe, decide, act.
///
/// All the decision logic lives in <see cref="WatchdogPolicy"/> and
/// <see cref="RestartLadder"/>, so it can be tested without Windows. This class only
/// reads the outside world and carries out the decisions.
///
/// Careful: no exception may escape this loop. If the watchdog dies nobody revives
/// anybody, and that is noticed only after ten silent minutes on the server, if
/// anyone reads the alert.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WatchdogLoop
{
    /// <summary>How long a killed process is given to die.</summary>
    private static readonly TimeSpan KillGrace = TimeSpan.FromSeconds(10);

    /// <summary>
    /// One line this often even if nothing changed, so the log does not look "dead".
    /// </summary>
    private static readonly TimeSpan HeartbeatLogEvery = TimeSpan.FromHours(1);

    private readonly AgentPaths _paths;
    private readonly RollingLog _log;
    private readonly string? _agentExeOverride;

    private readonly RestartLadder _ladder = new();
    private readonly HeartbeatReader _heartbeat = new();

    // Careful: MonotonicClock, not DateTimeOffset.Now. If someone sets the PC clock
    // back, the cool-off would never end and the watchdog would sit silently useless
    // while the log looked normal.
    private readonly MonotonicClock _clock = MonotonicClock.StartNow();

    private (WatchdogAction Action, WatchdogReason Reason, AgentHealth Health) _lastLogged;
    private DateTimeOffset _lastLogAt = DateTimeOffset.MinValue;
    private bool _alarmOnDisk;

    /// <summary>The <c>agent.restart</c> read on this tick (null if none): for the log line.</summary>
    private PlannedRestart? _plannedRestart;

    public WatchdogLoop(AgentPaths paths, RollingLog log, string? agentExeOverride)
    {
        _paths = paths;
        _log = log;
        _agentExeOverride = agentExeOverride;
    }

    public void Run(WaitHandle stop, TimeSpan period)
    {
        _log.Write($"Watch started — every {period.TotalSeconds:F0} seconds, data folder {_paths.DataDirectory}");
        _alarmOnDisk = File.Exists(_paths.Alarm);

        do
        {
            try
            {
                Tick();
            }
            catch (Exception ex)
            {
                // Should never get here, since each step below catches its own errors.
                // Still, this catch is the last resort: an unexpected bug must not
                // stop the watchdog for good.
                _log.Write($"❌ Unexpected error in the tick: {ex.GetType().Name} — {ex.Message}");
            }

            // A stop request lets us leave at once. With Sleep we would wait up to 30
            // seconds, and Windows does not wait that long on shutdown.
        } while (!stop.WaitOne(period) && !StopRequested());

        _log.Write("Watch stopped");
    }

    // ── one tick ────────────────────────────────────────────────────────────

    private void Tick()
    {
        var now = _clock.Now;
        var observation = Observe();

        if (observation is null)
        {
            // Could not even read the clock, so it is not safe to decide anything this tick.
            LogIfChanged(WatchdogAction.Hold, WatchdogReason.ProbeFailed, AgentHealth.Unknown,
                "Could not read the unbiased clock — skipping this tick", now);
            return;
        }

        var decision = WatchdogPolicy.Decide(observation, _ladder, now);
        LogIfChanged(decision.Action, decision.Reason, decision.Health, Describe(decision), now);

        switch (decision.Action)
        {
            case WatchdogAction.None:
                if (_alarmOnDisk && !_ladder.AlarmRaised)
                {
                    AlarmFile.Clear(_paths.Alarm);
                    _alarmOnDisk = false;
                    _log.Write("✅ The agent is running steadily again — the alarm was cleared");
                }
                break;

            case WatchdogAction.GiveUp:
                AlarmFile.Raise(
                    _paths.Alarm,
                    $"The agent did not survive {_ladder.Failures} launches " +
                    $"({Describe(decision.Reason)}). Next attempt in ~{_ladder.Policy.CoolOff.TotalHours:F0} hours.");
                _alarmOnDisk = true;
                _ladder.MarkAlarmRaised();
                _log.Write("🔴 Giving up — watchdog.alarm was written, waiting for the cool-off");
                break;

            case WatchdogAction.Restart:
                Restart(decision.KillProcessId, now);
                break;

            case WatchdogAction.Start:
                Start(now, decision.Planned);
                break;

            case WatchdogAction.Hold:
            default:
                break;
        }
    }

    /// <summary>
    /// Everything one tick needs from the outside world. Null if the clock cannot be read.
    /// </summary>
    private AgentObservation? Observe()
    {
        if (Kernel32.UnbiasedMs() is not { } nowUnbiased) return null;

        var session = SessionCheck.Check();
        var lockState = InstanceLock.Probe(_paths.AgentLock);
        var beat = _heartbeat.Read(_paths.Heartbeat);

        // Careful: read only when the lock is free. While the agent is still inside its graceful
        // exit the marker is already there; reading it every tick of a healthy agent would be a
        // pointless disk access 2,880 times a day.
        _plannedRestart = lockState == LockProbe.Free ? ReadPlannedRestart() : null;

        return new AgentObservation
        {
            ProbeSucceeded = lockState != LockProbe.Unknown,
            InstanceLockHeld = lockState == LockProbe.Held,
            ProcessId = beat?.ProcessId,
            ProcessAlive = beat is not null && AgentProcess.IsAlive(beat.ProcessId),
            HeartbeatUnbiasedMs = beat?.UnbiasedMs,
            NowUnbiasedMs = nowUnbiased,
            SessionUsable = session.CanSupervise,
            ShuttingDown = User32.IsShuttingDown(),
            PlannedRestartUnbiasedMs = _plannedRestart?.UnbiasedMs,
        };
    }

    private PlannedRestart? ReadPlannedRestart()
    {
        try
        {
            if (!File.Exists(_paths.RestartMarker)) return null;

            using var stream = new FileStream(
                _paths.RestartMarker, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return PlannedRestartFiles.TryParse(reader.ReadLine());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // Unreadable = no request: the agent is then started the ordinary way, on the ladder.
            return null;
        }
    }

    /// <summary>
    /// Careful: deleted on <b>every</b> start, planned or not. A marker is a one-shot request; one
    /// that survived a start could excuse the next crash from the ladder, which is the storm the
    /// ladder exists to stop.
    /// </summary>
    private void ConsumePlannedRestart()
    {
        _plannedRestart = null;

        try { File.Delete(_paths.RestartMarker); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Not dangerous: it expires by itself after PlannedRestartFiles.MaxAge.
            _log.Write($"⚠️ Could not delete agent.restart: {ex.Message}");
        }
    }

    // ── actions ─────────────────────────────────────────────────────────────

    private void Restart(int? pid, DateTimeOffset now)
    {
        if (pid is not { } victim)
        {
            _log.Write("⚠️ The agent is wedged, but the pid is unknown — nothing was done");
            return;
        }

        // The last counts the agent wrote: a wedge with 200,000 handles is a leak, not a bug in
        // the loop, and this line is the only place that would ever say so.
        var last = _heartbeat.LastGood;
        _log.Write($"⛔ The agent is wedged (heartbeat older than {AgentLiveness.StaleAfter.TotalSeconds:F0} s)" +
                   $"{Counts(last?.HandleCount, last?.PrivateBytes)} — killing it");

        if (!AgentProcess.TryKill(victim, KillGrace, out var killDetail))
        {
            // Careful: a failed kill also costs a step on the ladder. Otherwise the
            // watchdog would try every 30 seconds, forever, to kill a process that will
            // not die, without ever raising an alarm, so the problem would stay invisible.
            _ladder.RecordLaunch(now);
            _log.Write($"⚠️ {killDetail} (attempt {_ladder.Failures}/{_ladder.Policy.GiveUpAfter})");
            return;
        }

        _log.Write($"   {killDetail}");

        // Careful: a dying process can hold agent.lock for a few milliseconds. Starting
        // immediately would make the new agent fail to get the lock and exit, and the
        // ladder would count that as a failure. We proceed only once the lock is seen free.
        if (InstanceLock.Probe(_paths.AgentLock) != LockProbe.Free)
        {
            _log.Write("   The lock has not been released yet — it will be started on the next tick");
            return;
        }

        Start(now, planned: false);
    }

    private void Start(DateTimeOffset now, bool planned)
    {
        var exe = AgentPaths.ResolveAgentExecutable(_agentExeOverride);
        var request = _plannedRestart;

        if (planned)
        {
            // The agent left on purpose (resource ceiling): not a failure, so no step on the
            // ladder. See RestartLadder.RecordPlannedLaunch.
            _ladder.RecordPlannedLaunch(now);
            _log.Write($"🔄 Planned restart requested by the agent (pid {request?.ProcessId}, " +
                       $"{request?.Reason ?? "unknown"}{Counts(request?.HandleCount, request?.PrivateBytes)})");
        }
        else
        {
            // Careful: the ladder advances <b>before</b> launching. If the exe is missing or
            // antivirus blocked it, counting afterwards would never raise the count and the
            // loop would retry every 30 seconds forever, exactly the storm this prevents.
            _ladder.RecordLaunch(now);
        }

        if (File.Exists(_paths.RestartMarker)) ConsumePlannedRestart();

        if (exe is null)
        {
            _log.Write($"❌ {AgentPaths.AgentExeName} was not found ({AppContext.BaseDirectory}) — " +
                       $"attempt {_ladder.Failures}/{_ladder.Policy.GiveUpAfter}");
            return;
        }

        var ok = AgentProcess.TryStart(exe, out _, out var detail);

        _log.Write($"{(ok ? "▶" : "❌")} Agent start: {detail} " +
                   $"(attempt {_ladder.Failures}/{_ladder.Policy.GiveUpAfter}, " +
                   $"next one in {_ladder.TimeUntilNextLaunch(now).TotalSeconds:F0} s)");
    }

    // ── stop request ────────────────────────────────────────────────────────

    /// <summary>
    /// The installer/uninstaller can stop the watchdog gracefully by creating a
    /// <c>watchdog.stop</c> file.
    ///
    /// A named event could not be used: an installer running as SYSTEM and a watchdog in
    /// a user session live in different namespaces, and a standard user has no privilege
    /// to create a <c>Global\</c> name.
    /// </summary>
    private bool StopRequested()
    {
        try
        {
            if (!File.Exists(_paths.StopFile)) return false;

            _log.Write("🛑 watchdog.stop found — stopping");
            File.Delete(_paths.StopFile);
            return true;
        }
        catch (Exception)
        {
            // Stop even if the delete failed; otherwise the file would stay and stop the
            // watchdog right after every start.
            return true;
        }
    }

    // ── log ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Only <b>changes</b> are written. Writing every tick would mean 2,880 lines a day,
    /// the log would rotate twice a day, and the crash from two weeks ago that the admin
    /// opened the log to find would be gone.
    /// </summary>
    private void LogIfChanged(
        WatchdogAction action, WatchdogReason reason, AgentHealth health, string message, DateTimeOffset now)
    {
        var key = (action, reason, health);
        var stale = now - _lastLogAt >= HeartbeatLogEvery;

        if (key == _lastLogged && !stale) return;

        _lastLogged = key;
        _lastLogAt = now;
        _log.Write(message);
    }

    /// <summary><c>, 24,310 handles, 1,950 MB private</c>, or nothing if unknown.</summary>
    private static string Counts(long? handles, long? privateBytes) =>
        handles is null && privateBytes is null
            ? string.Empty
            : string.Create(
                CultureInfo.InvariantCulture,
                $", {handles?.ToString("N0", CultureInfo.InvariantCulture) ?? "?"} handles, " +
                $"{(privateBytes is { } p ? (p / 1_048_576).ToString("N0", CultureInfo.InvariantCulture) : "?")} MB private");

    private static string Describe(WatchdogDecision decision)
    {
        var retry = decision.RetryIn is { } left && left > TimeSpan.Zero
            ? $" ({left.TotalSeconds:F0} s left)"
            : string.Empty;

        return string.Create(
            CultureInfo.InvariantCulture,
            $"{Symbol(decision.Health)} {Describe(decision.Health)} — {Describe(decision.Reason)}{retry}");
    }

    private static string Symbol(AgentHealth health) => health switch
    {
        AgentHealth.Healthy => "✅",
        AgentHealth.NotRunning => "⛔",
        AgentHealth.Wedged => "🧊",
        AgentHealth.Unreachable => "❓",
        _ => "❓",
    };

    private static string Describe(AgentHealth health) => health switch
    {
        AgentHealth.Healthy => "the agent is healthy",
        AgentHealth.NotRunning => "the agent is not running",
        AgentHealth.Wedged => "the agent is wedged",
        AgentHealth.Unreachable => "the agent is there but out of reach",
        _ => "the state is unknown",
    };

    private static string Describe(WatchdogReason reason) => reason switch
    {
        WatchdogReason.Healthy => "the heartbeat is fresh",
        WatchdogReason.AgentMissing => "nobody is holding agent.lock",
        WatchdogReason.HeartbeatStale => "the heartbeat has stopped",
        WatchdogReason.ForeignInstance => "the lock is held but the process is unknown",
        WatchdogReason.BackoffPending => "backoff in progress",
        WatchdogReason.CoolOffPending => "gave up, cooling off",
        WatchdogReason.CoolOffProbe => "one attempt after the cool-off",
        WatchdogReason.LadderExhausted => "the agent did not survive repeated attempts",
        WatchdogReason.ShuttingDown => "Windows is shutting down",
        WatchdogReason.SessionNotUsable => "the agent cannot be started from this session",
        WatchdogReason.ProbeFailed => "the lock file could not be read at all",
        WatchdogReason.PlannedRestart => "the agent asked to be restarted",
        _ => reason.ToString(),
    };
}
