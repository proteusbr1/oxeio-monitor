using oXeio.Core.Watchdog;

namespace oXeio.Core.Tests;

public class RestartLadderTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 10, 9, 0, 0, TimeSpan.Zero);

    // ── the first attempt is immediate ──────────────────────────────────────

    /// <summary>
    /// H01's acceptance condition: kill it from Task Manager and it comes back within
    /// 30 seconds. Putting a backoff on the very first attempt would make that false.
    /// </summary>
    [Fact]
    public void The_first_crash_allows_an_immediate_relaunch()
    {
        var ladder = new RestartLadder();

        Assert.True(ladder.MayLaunch(T0));
        Assert.Equal(TimeSpan.Zero, ladder.TimeUntilNextLaunch(T0));
    }

    // ── ladder steps ────────────────────────────────────────────────────────

    [Theory]
    [InlineData(1, 30)]
    [InlineData(2, 90)]
    [InlineData(3, 270)]
    [InlineData(4, 810)]
    public void Each_failure_triples_the_wait(int failures, double seconds)
    {
        Assert.Equal(TimeSpan.FromSeconds(seconds), new RestartLadder().DelayAfter(failures));
    }

    [Fact]
    public void The_delay_never_exceeds_the_ceiling()
    {
        Assert.Equal(TimeSpan.FromMinutes(15), new RestartLadder().DelayAfter(5));
    }

    /// <summary>
    /// Throwing here would kill the watchdog itself, leaving a machine with no
    /// supervisor, and it would happen on exactly the machine that has been broken the longest.
    /// </summary>
    [Fact]
    public void Many_failures_do_not_overflow()
    {
        var ladder = new RestartLadder();

        Assert.Equal(TimeSpan.FromMinutes(15), ladder.DelayAfter(100_000));
        Assert.Equal(TimeSpan.FromMinutes(15), ladder.DelayAfter(int.MaxValue));
        Assert.Equal(TimeSpan.Zero, ladder.DelayAfter(0));
        Assert.Equal(TimeSpan.Zero, ladder.DelayAfter(-7));
    }

    [Fact]
    public void The_backoff_is_honoured_after_a_launch()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);

        Assert.False(ladder.MayLaunch(T0 + TimeSpan.FromSeconds(29)));
        Assert.True(ladder.MayLaunch(T0 + TimeSpan.FromSeconds(30)));
    }

    /// <summary>
    /// Careful: it is the attempt to start that raises the count, not "it started".
    /// Even if <c>Process.Start</c> throws (exe missing, blocked by AV) the ladder must
    /// advance; otherwise it would retry every 30 seconds forever.
    /// </summary>
    [Fact]
    public void Every_launch_is_counted_as_a_failure_up_front()
    {
        var ladder = new RestartLadder();

        ladder.RecordLaunch(T0);

        Assert.Equal(1, ladder.Failures);
    }

    // ── giving up and cooling off ───────────────────────────────────────────

    [Fact]
    public void It_gives_up_after_five_attempts()
    {
        var ladder = LaunchUntilExhausted(out var now);

        Assert.True(ladder.IsExhausted);
        Assert.False(ladder.MayLaunch(now));
    }

    /// <summary>
    /// Careful: giving up does not mean stopping for good. If it did, a temporary problem
    /// such as the exe being locked by an AV update would need a person to visit every
    /// one of the 15 PCs, and nobody's time would be counted until then.
    /// </summary>
    [Fact]
    public void After_the_cool_off_it_tries_once_more()
    {
        var ladder = LaunchUntilExhausted(out var now);
        var coolOff = ladder.Policy.CoolOff;

        Assert.False(ladder.MayLaunch(now + coolOff - TimeSpan.FromMinutes(1)));
        Assert.True(ladder.MayLaunch(now + coolOff));
    }

    /// <summary>If the cool-off interval were shorter than the ladder's biggest step,
    /// "giving up" would actually increase the attempts.</summary>
    [Fact]
    public void The_cool_off_is_longer_than_the_biggest_step()
    {
        Assert.True(RestartPolicy.Default.CoolOff >= RestartPolicy.Default.MaxDelay);
    }

    [Fact]
    public void Attempts_keep_going_after_giving_up()
    {
        var ladder = LaunchUntilExhausted(out var now);
        var coolOff = ladder.Policy.CoolOff;

        // one attempt after the cool-off; that fails too
        var probe = now + coolOff;
        ladder.RecordLaunch(probe);

        Assert.True(ladder.IsExhausted);
        Assert.False(ladder.MayLaunch(probe + TimeSpan.FromHours(1)));
        Assert.True(ladder.MayLaunch(probe + coolOff));
    }

    // ── alarm ───────────────────────────────────────────────────────────────

    [Fact]
    public void The_alarm_flag_is_remembered()
    {
        var ladder = LaunchUntilExhausted(out _);

        Assert.False(ladder.AlarmRaised);
        ladder.MarkAlarmRaised();
        Assert.True(ladder.AlarmRaised);
    }

    // ── reset ───────────────────────────────────────────────────────────────

    /// <summary>
    /// "Has started once" does not reset it: in a crash loop the process starts again
    /// and again anyway. Only continuous health counts.
    /// </summary>
    [Fact]
    public void A_short_healthy_spell_does_not_reset_the_ladder()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);

        ladder.Observe(healthy: true, T0 + TimeSpan.FromSeconds(10));
        ladder.Observe(healthy: false, T0 + TimeSpan.FromSeconds(20));
        ladder.Observe(healthy: true, T0 + TimeSpan.FromSeconds(30));

        Assert.Equal(1, ladder.Failures);
    }

    [Fact]
    public void Continuous_stability_resets_the_ladder()
    {
        var ladder = LaunchUntilExhausted(out var now);
        ladder.MarkAlarmRaised();

        ladder.Observe(healthy: true, now);
        ladder.Observe(healthy: true, now + RestartPolicy.Default.StabilityWindow);

        Assert.Equal(0, ladder.Failures);
        Assert.False(ladder.IsExhausted);
        Assert.False(ladder.AlarmRaised);
        Assert.True(ladder.MayLaunch(now));
    }

    /// <summary>An agent that crashes once a week must not reach the "given up" state
    /// after a month.</summary>
    [Fact]
    public void Occasional_crashes_do_not_accumulate_into_giving_up()
    {
        var ladder = new RestartLadder();
        var now = T0;

        for (var week = 0; week < 8; week++)
        {
            ladder.RecordLaunch(now);
            now += TimeSpan.FromMinutes(30);
            ladder.Observe(healthy: true, now);
            now += TimeSpan.FromDays(7);
            ladder.Observe(healthy: true, now);
        }

        Assert.False(ladder.IsExhausted);
    }

    // ── clock trouble ───────────────────────────────────────────────────────

    /// <summary>
    /// Careful: if a caller wrongly passes the wall clock and someone sets the clock
    /// back, the watchdog would silently wait forever: everyone thinks supervision is
    /// there, when it is not.
    /// </summary>
    [Fact]
    public void The_ladder_does_not_stay_stuck_when_the_clock_goes_back()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);

        var backwards = T0 - TimeSpan.FromHours(2);

        Assert.False(ladder.MayLaunch(backwards));
        Assert.Equal(TimeSpan.FromSeconds(30), ladder.TimeUntilNextLaunch(backwards));
    }

    [Fact]
    public void A_backwards_clock_restarts_the_stability_count()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);

        ladder.Observe(healthy: true, T0 + TimeSpan.FromHours(1));
        ladder.Observe(healthy: true, T0);           // the clock went back

        Assert.Equal(1, ladder.Failures);            // no bogus reset happened
        ladder.Observe(healthy: true, T0 + RestartPolicy.Default.StabilityWindow);
        Assert.Equal(0, ladder.Failures);
    }

    // ── settings validation ─────────────────────────────────────────────────

    [Fact]
    public void Impossible_settings_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartPolicy(
            TimeSpan.Zero, 3, TimeSpan.FromMinutes(15), 5, TimeSpan.FromHours(6), TimeSpan.FromMinutes(10)));

        // the ceiling is smaller than the base
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartPolicy(
            TimeSpan.FromMinutes(5), 3, TimeSpan.FromSeconds(30), 5, TimeSpan.FromHours(6), TimeSpan.FromMinutes(10)));

        // there must be at least one attempt before giving up
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartPolicy(
            TimeSpan.FromSeconds(30), 3, TimeSpan.FromMinutes(15), 0, TimeSpan.FromHours(6), TimeSpan.FromMinutes(10)));

        // the cool-off time is smaller than the biggest step
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartPolicy(
            TimeSpan.FromSeconds(30), 3, TimeSpan.FromMinutes(15), 5, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(10)));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Starts five times, failing every time, until the ladder is exhausted.
    /// <paramref name="now"/> comes back as <b>the moment of the last launch</b>, since
    /// the cool-off is counted from there.
    /// </summary>
    private static RestartLadder LaunchUntilExhausted(out DateTimeOffset now)
    {
        var ladder = new RestartLadder();
        now = T0;

        for (var i = 0; i < RestartPolicy.Default.GiveUpAfter; i++)
        {
            Assert.True(ladder.MayLaunch(now), $"{i + 1} নম্বর চেষ্টা আটকে গেছে");
            ladder.RecordLaunch(now);
            now += ladder.DelayAfter(ladder.Failures);
            ladder.Observe(healthy: false, now);
        }

        now = ladder.LastLaunchAt!.Value;
        return ladder;
    }
}
