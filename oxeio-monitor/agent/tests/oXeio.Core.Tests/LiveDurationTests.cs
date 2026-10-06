using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// The moving clock on screen (<see cref="LiveDuration"/>).
///
/// Careful: this came from the owner's complaint that after login in 0.4.7 the seconds
/// did not change. Seconds had been added to the digits, but the counted number itself
/// jumps (heartbeat / segment close), so nothing moved on screen.
/// </summary>
public class LiveDurationTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 18, 10, 0, 0, TimeSpan.FromHours(6));

    private static TimeSpan Min(double m) => TimeSpan.FromMinutes(m);

    /// <summary>
    /// The main claim: the clock advances even when the counted number does not change.
    /// </summary>
    [Fact]
    public void Seconds_advance_while_working()
    {
        var live = new LiveDuration();

        var at5 = live.Next(Min(120), T0, T0.AddSeconds(5), counting: true);
        var at9 = live.Next(Min(120), T0, T0.AddSeconds(9), counting: true);

        Assert.Equal(Min(120) + TimeSpan.FromSeconds(5), at5);
        Assert.Equal(Min(120) + TimeSpan.FromSeconds(9), at9);
    }

    /// <summary>
    /// The clock stops when idle: the rule is "counting stops after 60 seconds without
    /// hands on the machine". If it kept running while idle, the window would contradict its own
    /// text.
    /// </summary>
    [Fact]
    public void The_clock_stands_still_when_idle()
    {
        var live = new LiveDuration();

        var shown = live.Next(Min(120), T0, T0.AddMinutes(3), counting: false);

        Assert.Equal(Min(120), shown);
    }

    /// <summary>Careful: with no anchor known, not even one second is made up.</summary>
    [Fact]
    public void Nothing_is_added_without_an_anchor()
    {
        var live = new LiveDuration();

        var shown = live.Next(Min(120), countedAt: null, T0.AddHours(2), counting: true);

        Assert.Equal(Min(120), shown);
    }

    /// <summary>
    /// The most important guard: if the server goes silent, the window must not
    /// <b>invent</b> hours on its own. At the ceiling the number freezes.
    /// </summary>
    [Fact]
    public void A_stale_anchor_is_capped_at_the_ceiling()
    {
        var live = new LiveDuration();

        var shown = live.Next(Min(120), T0, T0.AddHours(3), counting: true);

        Assert.Equal(Min(120) + LiveDuration.MaxDrift, shown);
    }

    /// <summary>
    /// The heartbeat's number is the sum of uploaded segments, so it sometimes comes in
    /// <b>lower</b> than what we show. Even then the clock does not go backwards: seeing
    /// "I worked, yet the time went down" would make the whole system unbelievable.
    /// </summary>
    [Fact]
    public void The_clock_does_not_go_back_when_a_lower_number_arrives()
    {
        var live = new LiveDuration();

        var before = live.Next(Min(120), T0, T0.AddMinutes(2), counting: true); // 122
        // next heartbeat: the server said 121 (something is still sitting in the queue)
        var after = live.Next(Min(121), T0.AddMinutes(2), T0.AddMinutes(2), counting: true);

        Assert.Equal(Min(122), before);
        Assert.Equal(Min(122), after);
    }

    /// <summary>
    /// Careful: at midnight in the work zone today's total resets to zero. Holding on to the
    /// previous value then would make the window show yesterday's total all of tomorrow.
    /// </summary>
    [Fact]
    public void A_midnight_reset_to_zero_starts_over()
    {
        var live = new LiveDuration();
        live.Next(Min(300), T0, T0.AddMinutes(1), counting: true);

        var afterMidnight = live.Next(
            TimeSpan.Zero, T0.AddHours(14), T0.AddHours(14), counting: true);

        Assert.Equal(TimeSpan.Zero, afterMidnight);
    }

    /// <summary>Careful: if the machine clock goes back, no negative time is added.</summary>
    [Fact]
    public void Nothing_is_added_when_the_machine_clock_goes_back()
    {
        var live = new LiveDuration();

        var shown = live.Next(Min(120), T0, T0.AddMinutes(-5), counting: true);

        Assert.Equal(Min(120), shown);
    }

    /// <summary>
    /// <b>A field complaint: the seconds keep getting stuck.</b>
    ///
    /// In 0.4.8, <c>counted</c> came from the server's heartbeat, which is always
    /// <b>behind</b> (segments awaiting upload sit in the queue). When a new heartbeat
    /// arrived the candidate was lower than the value already shown, and the "no going
    /// back" rule then <b>held the clock still</b> until the candidate passed that
    /// value: a stall of a few minutes in every cycle.
    ///
    /// The fix: <c>counted</c> is now supplied by the host including the open segment,
    /// so it grows continuously by itself. This test guards that continuity: the clock
    /// advances <b>strictly</b> every second, including at the moment the snapshot changes.
    /// </summary>
    [Fact]
    public void The_clock_does_not_stall_even_at_the_moment_the_snapshot_changes()
    {
        var live = new LiveDuration();
        var previous = TimeSpan.MinValue;

        // the host gives a new snapshot every 5 minutes; the window counts the seconds between
        for (var second = 0; second <= 15 * 60; second++)
        {
            var snapshotSecond = second / 300 * 300;          // when the last snapshot was
            var snapshotAt = T0.AddSeconds(snapshotSecond);

            // the host's number includes the open segment, correct up to the snapshot moment
            var counted = Min(120) + TimeSpan.FromSeconds(snapshotSecond);

            var shown = live.Next(counted, snapshotAt, T0.AddSeconds(second), counting: true);

            Assert.True(
                shown > previous,
                $"{second} সেকেন্ডে ঘড়ি আটকে গেছে ({previous} → {shown})");

            previous = shown;
        }

        // after 15 minutes of work it grew by exactly 15 minutes, not one second more
        Assert.Equal(Min(135), previous);
    }

    /// <summary>
    /// Careful: the ceiling must be larger than the maximum interval between status
    /// publishes (5 minutes; the heartbeat and <c>MaxSegmentLength</c> are both that). If
    /// equal, the clock would stall at the very last moment, which is exactly what
    /// happened in 0.4.8.
    /// </summary>
    [Fact]
    public void The_ceiling_is_larger_than_the_publish_interval()
    {
        Assert.True(LiveDuration.MaxDrift > TimeSpan.FromMinutes(5));
    }

    /// <summary>
    /// When a new counted number arrives it becomes the base; the clock runs from there.
    /// </summary>
    [Fact]
    public void A_new_counted_number_becomes_the_new_base()
    {
        var live = new LiveDuration();
        live.Next(Min(120), T0, T0.AddSeconds(30), counting: true); // 120:30

        var t1 = T0.AddMinutes(1);
        var shown = live.Next(Min(125), t1, t1.AddSeconds(10), counting: true);

        Assert.Equal(Min(125) + TimeSpan.FromSeconds(10), shown);
    }
}
