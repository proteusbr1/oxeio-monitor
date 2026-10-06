using oXeio.Agent.Ui;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Tests;

/// <summary>
/// J03: the balloon when the monthly target is reached.
///
/// The only real risk here is <b>showing it repeatedly</b>. If a balloon popped up on
/// every heartbeat, staff would turn off oXeio notifications in Windows settings for
/// good, and then sync failures and device-revoked messages would never reach them
/// either. So the tests concentrate on this.
/// </summary>
public class MonthlyMilestoneTests
{
    private static readonly DateTimeOffset August =
        new(2026, 8, 20, 12, 0, 0, TimeSpan.FromHours(6));

    private static AgentStatus Status(
        double monthHours, double target = 208, bool known = true) => new()
    {
        State = SegmentState.Active,
            Update = UpdateStatus.Idle,
        ActiveToday = TimeSpan.FromHours(6),
        ActiveThisMonth = TimeSpan.FromHours(monthHours),
        MonthlyTargetHours = target,
        MonthlyKnown = known,
        QueueDepth = 0,
        Health = SyncHealth.Ok,
        Paused = false,
        Enrolled = true,
    };

    [Fact]
    public void Reaching_the_target_shows_the_balloon_once()
    {
        Assert.True(MonthlyMilestone.ShouldCelebrate(Status(208), August, null, out var key));
        Assert.Equal("2026-08", key);
    }

    /// <summary>This test is the feature's only hard promise.</summary>
    [Fact]
    public void No_second_balloon_in_the_same_month() =>
        Assert.False(MonthlyMilestone.ShouldCelebrate(Status(300), August, "2026-08", out _));

    [Fact]
    public void The_balloon_shows_again_the_next_month()
    {
        var september = new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.FromHours(6));

        Assert.True(MonthlyMilestone.ShouldCelebrate(Status(210), september, "2026-08", out var key));
        Assert.Equal("2026-09", key);
    }

    [Fact]
    public void Nothing_before_the_target_is_reached() =>
        Assert.False(MonthlyMilestone.ShouldCelebrate(Status(207.9), August, null, out _));

    /// <summary>
    /// Careful: if the server has never reported progress, the month total is zero
    /// (<see cref="AgentStatus.Starting"/>). A balloon in that state would send a bogus
    /// congratulation at every moment of startup.
    /// </summary>
    [Fact]
    public void No_balloon_in_the_starting_state() =>
        Assert.False(MonthlyMilestone.ShouldCelebrate(AgentStatus.Starting, August, null, out _));

    /// <summary>
    /// Careful: if the number did not come from the server there is no congratulation,
    /// even if the field holds a large value. "I don't know" can never become "target met".
    /// </summary>
    [Fact]
    public void No_balloon_when_the_server_has_not_said() =>
        Assert.False(MonthlyMilestone.ShouldCelebrate(
            Status(250, known: false), August, null, out _));

    /// <summary>
    /// With a target of 0 there is nothing to call "met"; otherwise zero hours would earn a
    /// congratulation.
    /// </summary>
    [Fact]
    public void No_balloon_when_the_target_is_zero() =>
        Assert.False(MonthlyMilestone.ShouldCelebrate(Status(0, target: 0), August, null, out _));

    /// <summary>
    /// The work zone's month, not UTC. 1 September 02:00 (local, UTC+6 in tests) is 31 August 20:00 UTC; with
    /// UTC the September balloon would be filed under August and shown again in
    /// September.
    /// </summary>
    [Fact]
    public void The_month_key_uses_the_work_zone_calendar()
    {
        var justAfterMidnight = new DateTimeOffset(2026, 9, 1, 2, 0, 0, TimeSpan.FromHours(6));

        Assert.Equal("2026-09", MonthlyMilestone.MonthKeyOf(justAfterMidnight));
    }

    /// <summary>The balloon text contains the target number, and no instruction.</summary>
    [Fact]
    public void The_balloon_text_is_news_only()
    {
        var text = MonthlyMilestone.Text(208);

        Assert.Contains("208", text, StringComparison.Ordinal);
        Assert.DoesNotContain("rest", text, StringComparison.OrdinalIgnoreCase);
    }

    // ── memory on disk ──────────────────────────────────────────────────────

    /// <summary>
    /// Careful: if it forgot on every restart, "once a month" would effectively be
    /// "once a day", since office PCs are switched off every night.
    /// </summary>
    [Fact]
    public void The_memory_survives_a_restart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "oXeio-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);

        try
        {
            new MilestoneMemory(dir).Remember("2026-08");

            // a new instance = a new process
            Assert.Equal("2026-08", new MilestoneMemory(dir).LastCelebrated());
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { }
        }
    }

    /// <summary>
    /// The folder does not exist at all: the read fails, but it must not throw. This is
    /// called on the tray render path, where an exception would kill the UI thread,
    /// which means hour counting stops.
    /// </summary>
    [Fact]
    public void An_unreadable_memory_does_not_throw()
    {
        var memory = new MilestoneMemory(
            Path.Combine(Path.GetTempPath(), "oXeio-missing-" + Guid.NewGuid().ToString("N")));

        Assert.Null(memory.LastCelebrated());
    }
}
