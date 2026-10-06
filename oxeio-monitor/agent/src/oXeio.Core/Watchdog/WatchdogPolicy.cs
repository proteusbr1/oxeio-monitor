namespace oXeio.Core.Watchdog;

/// <summary>The agent's state: not "is it running" but "is it working".</summary>
public enum AgentHealth
{
    /// <summary>Could not be determined (disk/ACL trouble). Must not be treated as "absent".</summary>
    Unknown,

    /// <summary>Nobody holds the instance lock: there is no agent on the machine.</summary>
    NotRunning,

    /// <summary>The lock is held and the heartbeat is fresh.</summary>
    Healthy,

    /// <summary>The lock is held but the heartbeat has stopped, and we can kill the pid.</summary>
    Wedged,

    /// <summary>
    /// The lock is held, there is no heartbeat, but we do not know whom to kill:
    /// a process in another session, or AV/backup is holding the file.
    /// </summary>
    Unreachable,
}

/// <summary>What the watchdog will do on this tick.</summary>
public enum WatchdogAction
{
    None,

    /// <summary>Start the agent.</summary>
    Start,

    /// <summary>Kill the wedged agent, then start it.</summary>
    Restart,

    /// <summary>Something is wrong, but it must not be touched now.</summary>
    Hold,

    /// <summary>The ladder is spent: give a visible signal, then cool off.</summary>
    GiveUp,
}

/// <summary>
/// The reason for the decision. An enum, not a string: the log text is built in the watchdog
/// project, so Core stays testable and language-neutral.
/// </summary>
public enum WatchdogReason
{
    Healthy,
    AgentMissing,
    HeartbeatStale,
    ForeignInstance,
    BackoffPending,
    CoolOffPending,
    CoolOffProbe,
    LadderExhausted,
    ShuttingDown,
    SessionNotUsable,
    ProbeFailed,
}

/// <summary>What was learned from the outside world in one tick.</summary>
public sealed record AgentObservation
{
    /// <summary>Whether the lock file could be probed. false = we know nothing.</summary>
    public required bool ProbeSucceeded { get; init; }

    /// <summary>Someone holds <c>agent.lock</c>: an agent is alive somewhere.</summary>
    public required bool InstanceLockHeld { get; init; }

    /// <summary>The pid from the heartbeat file (null if not obtained).</summary>
    public int? ProcessId { get; init; }

    /// <summary>Whether an agent process is really running at that pid.</summary>
    public required bool ProcessAlive { get; init; }

    /// <summary>The unbiased milliseconds written in the heartbeat (null if the file could not be read).</summary>
    public long? HeartbeatUnbiasedMs { get; init; }

    /// <summary>The watchdog's own unbiased milliseconds, right now.</summary>
    public required long NowUnbiasedMs { get; init; }

    /// <summary>Whether the watchdog is in an interactive session (not Session 0).</summary>
    public required bool SessionUsable { get; init; }

    /// <summary>Whether Windows is shutting down/logging off right now.</summary>
    public required bool ShuttingDown { get; init; }
}

public sealed record WatchdogDecision
{
    public required WatchdogAction Action { get; init; }
    public required WatchdogReason Reason { get; init; }
    public required AgentHealth Health { get; init; }

    /// <summary>Whom to kill when <see cref="WatchdogAction.Restart"/>.</summary>
    public int? KillProcessId { get; init; }

    /// <summary>How much longer, when told to wait.</summary>
    public TimeSpan? RetryIn { get; init; }
}

/// <summary>
/// All of the watchdog's decisions in this one function: no I/O, so it can be tested without
/// Windows.
///
/// <b>The key asymmetry in the design:</b> wrongly thinking "no agent" and wrongly thinking
/// "agent present" do not cost the same.
/// <list type="bullet">
/// <item>Wrongly thinking "present": it starts 30 seconds late. Invisible in the hours count.</item>
/// <item>Wrongly thinking "absent": a second agent starts, and the two count the same hours
/// twice. Payroll is corrupted and nobody notices.</item>
/// </list>
/// So every benefit of the doubt goes to "agent present": probe failed, unknown who holds the
/// lock, shutdown under way: all of them give <see cref="WatchdogAction.Hold"/>.
/// </summary>
public static class WatchdogPolicy
{
    /// <summary>
    /// Observation → health. The lock file alone answers the first question ("is anyone
    /// there?"); the heartbeat answers the second ("is it working?").
    /// </summary>
    public static AgentHealth Classify(AgentObservation observation, TimeSpan staleAfter)
    {
        ArgumentNullException.ThrowIfNull(observation);

        if (!observation.ProbeSucceeded) return AgentHealth.Unknown;
        if (!observation.InstanceLockHeld) return AgentHealth.NotRunning;

        if (observation.HeartbeatUnbiasedMs is { } beat)
        {
            // A negative age = a file from the previous boot, not fresh.
            // See the comment on AgentLiveness.Age.
            var age = observation.NowUnbiasedMs - beat;
            if (age >= 0 && age <= (long)staleAfter.TotalMilliseconds) return AgentHealth.Healthy;
        }

        // The lock is held yet the heartbeat has stopped: it is wedged. But killing needs a
        // pid, and our process must really be running at that pid.
        return observation.ProcessAlive && observation.ProcessId is > 0
            ? AgentHealth.Wedged
            : AgentHealth.Unreachable;
    }

    /// <summary>
    /// This method updates the health observation of <paramref name="ladder"/>
    /// (<see cref="RestartLadder.Observe"/>) but does <b>not</b> do
    /// <see cref="RestartLadder.RecordLaunch"/>: that is the caller's job, just before the launch attempt.
    /// </summary>
    public static WatchdogDecision Decide(
        AgentObservation observation,
        RestartLadder ladder,
        DateTimeOffset now,
        TimeSpan? staleAfter = null)
    {
        ArgumentNullException.ThrowIfNull(observation);
        ArgumentNullException.ThrowIfNull(ladder);

        var limit = staleAfter ?? AgentLiveness.StaleAfter;
        var health = Classify(observation, limit);

        // ── Cases where touching anything would be wrong ──────────────────────

        // Windows is shutting down: the agent will die now, which is not a failure. Starting
        // one at this time could block the shutdown, and it would waste a step of the ladder.
        if (observation.ShuttingDown)
            return Hold(WatchdogReason.ShuttingDown, health);

        // Starting from Session 0 puts the child in Session 0 too, where the agent's
        // SessionGuard shuts it down at once: creating a certain-to-fail process again and
        // again. A perfect recipe for a storm.
        if (!observation.SessionUsable)
            return Hold(WatchdogReason.SessionNotUsable, health);

        // The probe itself failed, so we do not know whether the lock is free. Assuming
        // "free" would start a second agent; see the asymmetry above.
        if (health == AgentHealth.Unknown)
            return Hold(WatchdogReason.ProbeFailed, health);

        // ── Healthy ───────────────────────────────────────────────────────────

        ladder.Observe(health == AgentHealth.Healthy, now);

        if (health == AgentHealth.Healthy)
            return new WatchdogDecision
            {
                Action = WatchdogAction.None,
                Reason = WatchdogReason.Healthy,
                Health = health,
            };

        // We do not know who holds the lock: no killing and no starting.
        // A mistake costs 30 seconds; the opposite costs hours counted twice.
        if (health == AgentHealth.Unreachable)
            return Hold(WatchdogReason.ForeignInstance, health);

        // ── Give-up signal ────────────────────────────────────────────────────

        if (ladder.IsExhausted && !ladder.AlarmRaised)
            return new WatchdogDecision
            {
                Action = WatchdogAction.GiveUp,
                Reason = WatchdogReason.LadderExhausted,
                Health = health,
                RetryIn = ladder.TimeUntilNextLaunch(now),
            };

        // ── Backoff ───────────────────────────────────────────────────────────

        if (!ladder.MayLaunch(now))
            return new WatchdogDecision
            {
                Action = WatchdogAction.Hold,
                Reason = ladder.IsExhausted ? WatchdogReason.CoolOffPending : WatchdogReason.BackoffPending,
                Health = health,
                RetryIn = ladder.TimeUntilNextLaunch(now),
            };

        // ── Start / restart ───────────────────────────────────────────────────

        var reason = ladder.IsExhausted
            ? WatchdogReason.CoolOffProbe
            : health == AgentHealth.Wedged
                ? WatchdogReason.HeartbeatStale
                : WatchdogReason.AgentMissing;

        return health == AgentHealth.Wedged
            ? new WatchdogDecision
            {
                Action = WatchdogAction.Restart,
                Reason = reason,
                Health = health,
                KillProcessId = observation.ProcessId,
            }
            : new WatchdogDecision
            {
                Action = WatchdogAction.Start,
                Reason = reason,
                Health = health,
            };
    }

    private static WatchdogDecision Hold(WatchdogReason reason, AgentHealth health) => new()
    {
        Action = WatchdogAction.Hold,
        Reason = reason,
        Health = health,
    };
}
