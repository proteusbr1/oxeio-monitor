using oXeio.Core.Watchdog;

namespace oXeio.Core.Tests;

public class WatchdogPolicyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 10, 9, 0, 0, TimeSpan.Zero);

    private const long Now = 3_600_000;   // 1 hour since boot, unbiased ms

    /// <summary>A healthy agent: lock held, heartbeat 5 seconds old.</summary>
    private static AgentObservation Healthy => new()
    {
        ProbeSucceeded = true,
        InstanceLockHeld = true,
        ProcessId = 4242,
        ProcessAlive = true,
        HeartbeatUnbiasedMs = Now - 5_000,
        NowUnbiasedMs = Now,
        SessionUsable = true,
        ShuttingDown = false,
    };

    // ── the normal path ─────────────────────────────────────────────────────

    [Fact]
    public void A_healthy_agent_is_left_alone()
    {
        var d = WatchdogPolicy.Decide(Healthy, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.None, d.Action);
        Assert.Equal(AgentHealth.Healthy, d.Health);
    }

    [Fact]
    public void A_free_lock_means_the_agent_is_started()
    {
        var obs = Healthy with { InstanceLockHeld = false, ProcessAlive = false, HeartbeatUnbiasedMs = null };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Start, d.Action);
        Assert.Equal(AgentHealth.NotRunning, d.Health);
        Assert.Equal(WatchdogReason.AgentMissing, d.Reason);
    }

    /// <summary>
    /// The real reason for this module: the process is alive yet not working. A
    /// watchdog that only checks "does the process exist" would never catch this failure.
    /// </summary>
    [Fact]
    public void A_stale_heartbeat_means_kill_and_restart()
    {
        var obs = Healthy with { HeartbeatUnbiasedMs = Now - 300_000 };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Restart, d.Action);
        Assert.Equal(AgentHealth.Wedged, d.Health);
        Assert.Equal(4242, d.KillProcessId);
    }

    [Fact]
    public void A_missing_heartbeat_file_counts_as_wedged_too()
    {
        var obs = Healthy with { HeartbeatUnbiasedMs = null };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Restart, d.Action);
    }

    [Fact]
    public void A_heartbeat_just_inside_the_limit_is_fresh()
    {
        var obs = Healthy with
        {
            HeartbeatUnbiasedMs = Now - (long)AgentLiveness.StaleAfter.TotalMilliseconds,
        };

        Assert.Equal(AgentHealth.Healthy, WatchdogPolicy.Classify(obs, AgentLiveness.StaleAfter));
    }

    /// <summary>
    /// After a reboot the heartbeat file stays on disk but the unbiased counter starts
    /// from zero. If a "future" timestamp were treated as fresh, the watchdog would sit
    /// there thinking a dead agent was healthy.
    /// </summary>
    [Fact]
    public void A_heartbeat_from_a_previous_boot_is_not_fresh()
    {
        var obs = Healthy with { HeartbeatUnbiasedMs = Now + 600_000 };

        Assert.Equal(AgentHealth.Wedged, WatchdogPolicy.Classify(obs, AgentLiveness.StaleAfter));
    }

    // ── where touching anything is wrong ────────────────────────────────────

    /// <summary>
    /// Careful: a failed probe does not mean "lock free". If it were treated as free, a
    /// second agent would start and the two would count the same hour twice: payroll
    /// ruined, and nobody would notice.
    /// </summary>
    [Fact]
    public void A_failed_probe_never_starts_an_agent()
    {
        var obs = Healthy with { ProbeSucceeded = false, InstanceLockHeld = false };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.ProbeFailed, d.Reason);
    }

    /// <summary>
    /// Careful: a child started from Session 0 also lands in Session 0, where the
    /// agent's SessionGuard shuts it down immediately: an endless storm of certain-to-fail
    /// processes, on 15 PCs at once.
    /// </summary>
    [Fact]
    public void Nothing_is_started_from_session_zero()
    {
        var obs = Healthy with { InstanceLockHeld = false, SessionUsable = false };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.SessionNotUsable, d.Reason);
    }

    [Fact]
    public void Nothing_is_started_during_shutdown()
    {
        var obs = Healthy with { InstanceLockHeld = false, ShuttingDown = true };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.ShuttingDown, d.Reason);
    }

    /// <summary>
    /// The agent dying at shutdown is not a failure; it must not waste a ladder step.
    /// </summary>
    [Fact]
    public void Shutdown_does_not_spoil_the_stability_count()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);
        ladder.Observe(healthy: true, T0);

        WatchdogPolicy.Decide(Healthy with { ShuttingDown = true }, ladder, T0 + TimeSpan.FromSeconds(30));
        WatchdogPolicy.Decide(Healthy, ladder, T0 + RestartPolicy.Default.StabilityWindow);

        Assert.Equal(0, ladder.Failures);
    }

    /// <summary>
    /// The lock is held but the pid is unknown: an agent in another session, or AV/backup
    /// holding the file. Waiting by mistake costs 30 seconds; starting a second one by
    /// mistake costs an hour counted twice.
    /// </summary>
    [Fact]
    public void A_foreign_lock_holder_is_neither_killed_nor_replaced()
    {
        var obs = Healthy with { ProcessId = null, ProcessAlive = false, HeartbeatUnbiasedMs = null };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(AgentHealth.Unreachable, d.Health);
        Assert.Equal(WatchdogReason.ForeignInstance, d.Reason);
    }

    // ── preventing the storm ────────────────────────────────────────────────

    [Fact]
    public void No_second_start_right_after_a_start()
    {
        var ladder = new RestartLadder();
        var missing = Healthy with { InstanceLockHeld = false, ProcessAlive = false, HeartbeatUnbiasedMs = null };

        Assert.Equal(WatchdogAction.Start, WatchdogPolicy.Decide(missing, ladder, T0).Action);
        ladder.RecordLaunch(T0);

        var d = WatchdogPolicy.Decide(missing, ladder, T0 + TimeSpan.FromSeconds(1));

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.BackoffPending, d.Reason);
        Assert.NotNull(d.RetryIn);
    }

    /// <summary>
    /// An agent that crashes at startup: a naive watchdog would spawn a process twice a
    /// second here. This test says that after five attempts it stops and a visible signal is
    /// raised.
    /// </summary>
    [Fact]
    public void Repeated_failures_raise_the_alarm_only_once()
    {
        var ladder = new RestartLadder();
        var missing = Healthy with { InstanceLockHeld = false, ProcessAlive = false, HeartbeatUnbiasedMs = null };
        var now = T0;

        for (var i = 0; i < RestartPolicy.Default.GiveUpAfter; i++)
        {
            var d = WatchdogPolicy.Decide(missing, ladder, now);
            Assert.Equal(WatchdogAction.Start, d.Action);
            ladder.RecordLaunch(now);
            now += ladder.DelayAfter(ladder.Failures);
        }

        var alarm = WatchdogPolicy.Decide(missing, ladder, now);
        Assert.Equal(WatchdogAction.GiveUp, alarm.Action);
        Assert.Equal(WatchdogReason.LadderExhausted, alarm.Reason);

        ladder.MarkAlarmRaised();

        // Careful: no alarm the second time; otherwise the log would fill every 30
        // seconds and the important lines would rotate away.
        var after = WatchdogPolicy.Decide(missing, ladder, now);
        Assert.Equal(WatchdogAction.Hold, after.Action);
        Assert.Equal(WatchdogReason.CoolOffPending, after.Reason);
    }

    /// <summary>
    /// Giving up does not mean stopping for good: exactly one attempt after 6 hours.
    /// </summary>
    [Fact]
    public void One_attempt_is_made_after_the_cool_off()
    {
        var ladder = new RestartLadder();
        var missing = Healthy with { InstanceLockHeld = false, ProcessAlive = false, HeartbeatUnbiasedMs = null };
        var now = T0;

        for (var i = 0; i < RestartPolicy.Default.GiveUpAfter; i++)
        {
            ladder.RecordLaunch(now);
            now += ladder.DelayAfter(ladder.Failures);
        }

        ladder.MarkAlarmRaised();
        var probeAt = ladder.LastLaunchAt!.Value + RestartPolicy.Default.CoolOff;

        var d = WatchdogPolicy.Decide(missing, ladder, probeAt);

        Assert.Equal(WatchdogAction.Start, d.Action);
        Assert.Equal(WatchdogReason.CoolOffProbe, d.Reason);
    }
}
