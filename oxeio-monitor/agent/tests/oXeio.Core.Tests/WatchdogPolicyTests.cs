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
    public void সুস্থ_থাকলে_কিছুই_করা_হয়_না()
    {
        var d = WatchdogPolicy.Decide(Healthy, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.None, d.Action);
        Assert.Equal(AgentHealth.Healthy, d.Health);
    }

    [Fact]
    public void লক_খালি_থাকলে_চালু_করা_হয়()
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
    public void হার্টবিট_বাসি_হলে_মেরে_আবার_চালু_করা_হয়()
    {
        var obs = Healthy with { HeartbeatUnbiasedMs = Now - 300_000 };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Restart, d.Action);
        Assert.Equal(AgentHealth.Wedged, d.Health);
        Assert.Equal(4242, d.KillProcessId);
    }

    [Fact]
    public void হার্টবিট_ফাইল_না_থাকলেও_জমে_যাওয়া_ধরা_হয়()
    {
        var obs = Healthy with { HeartbeatUnbiasedMs = null };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Restart, d.Action);
    }

    [Fact]
    public void সীমার_ঠিক_ভেতরের_হার্টবিট_তাজা()
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
    public void আগের_বুটের_হার্টবিট_তাজা_ধরা_হয়_না()
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
    public void probe_ব্যর্থ_হলে_কখনোই_চালু_করা_হয়_না()
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
    public void সেশন_শূন্যে_চালু_করা_হয়_না()
    {
        var obs = Healthy with { InstanceLockHeld = false, SessionUsable = false };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.SessionNotUsable, d.Reason);
    }

    [Fact]
    public void শাটডাউনের_সময়_চালু_করা_হয়_না()
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
    public void শাটডাউনে_স্থিরতার_হিসাব_নষ্ট_হয়_না()
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
    public void অচেনা_কেউ_লক_ধরে_থাকলে_মারাও_হয়_না_চালুও_হয়_না()
    {
        var obs = Healthy with { ProcessId = null, ProcessAlive = false, HeartbeatUnbiasedMs = null };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(AgentHealth.Unreachable, d.Health);
        Assert.Equal(WatchdogReason.ForeignInstance, d.Reason);
    }

    // ── preventing the storm ────────────────────────────────────────────────

    [Fact]
    public void চালু_করার_পরপরই_আবার_চালু_করা_হয়_না()
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
    public void বারবার_ব্যর্থ_হলে_একবারই_অ্যালার্ম_ওঠে()
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
    public void ঠান্ডা_হওয়ার_পর_একবার_চেষ্টা_হয়()
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
