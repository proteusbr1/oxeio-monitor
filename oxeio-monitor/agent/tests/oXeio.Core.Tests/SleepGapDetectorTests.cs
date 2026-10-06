using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

public class SleepGapDetectorTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 9, 11, 0, 0, TimeSpan.Zero); // 5 PM local (UTC+6 in tests)

    private static SleepGapDetector New() =>
        new(TimeSpan.FromSeconds(1));

    private static SleepGapDetector.Sample At(long seconds, long sleptSeconds = 0) =>
        new(
            BiasedMs: (ulong)(seconds * 1000),
            UnbiasedMs: (ulong)((seconds - sleptSeconds) * 1000),
            Monotonic: T0.AddSeconds(seconds));

    [Fact]
    public void The_first_sample_never_detects_sleep()
    {
        Assert.False(New().Observe(At(100)).Detected);
    }

    [Fact]
    public void Normal_one_second_ticks_detect_nothing()
    {
        var d = New();
        d.Observe(At(100));

        for (var i = 101; i < 200; i++)
            Assert.False(d.Observe(At(i)).Detected);
    }

    [Fact]
    public void Slight_timer_slack_is_not_taken_for_sleep()
    {
        var d = New();
        d.Observe(At(100));

        // 1.4 seconds: inside the tolerance of 1.5
        var gap = d.Observe(new SleepGapDetector.Sample(101_400, 101_400, T0.AddSeconds(101.4)));
        Assert.False(gap.Detected);
    }

    /// <summary>A laptop shut at 5 PM and opened at 9 AM: 16 hours of bogus work.</summary>
    [Fact]
    public void A_sixteen_hour_sleep_is_detected_and_stops_at_the_last_awake_moment()
    {
        var d = New();
        d.Observe(At(100));

        const int sixteenHours = 16 * 60 * 60;
        var gap = d.Observe(At(101 + sixteenHours, sleptSeconds: sixteenHours));

        Assert.True(gap.Detected);
        // the segment closes at the moment of going to sleep, not at the moment of waking
        Assert.Equal(T0.AddSeconds(100), gap.SuspendedAt);
        Assert.Equal(T0.AddSeconds(101 + sixteenHours), gap.ResumedAt);
        Assert.Equal(TimeSpan.FromHours(16), gap.SleptFor);
    }

    /// <summary>
    /// No suspend event arrived (Windows sends nothing when the battery dies), yet it
    /// must still be caught from the clock alone.
    /// </summary>
    [Fact]
    public void Sleep_is_detected_from_the_clocks_alone_without_an_event()
    {
        var d = New();
        d.Observe(At(100));

        var gap = d.Observe(At(400, sleptSeconds: 299));

        Assert.True(gap.Detected);
        Assert.Equal(TimeSpan.FromSeconds(299), gap.SleptFor);
    }

    /// <summary>
    /// In S0ix the process itself is frozen, so the unbiased clock can also advance.
    /// Even so it must be caught from the monotonic jump.
    /// </summary>
    [Fact]
    public void Sleep_is_detected_from_the_monotonic_jump_even_if_the_unbiased_clock_advances()
    {
        var d = New();
        d.Observe(At(100));

        // both biased and unbiased advanced 300 seconds, so it is not marked as "sleep",
        // yet the process did not run for 300 seconds
        var gap = d.Observe(new SleepGapDetector.Sample(400_000, 400_000, T0.AddSeconds(400)));

        Assert.True(gap.Detected);
        Assert.Equal(T0.AddSeconds(100), gap.SuspendedAt);
    }

    [Fact]
    public void The_slept_duration_is_never_negative_even_if_a_counter_goes_back()
    {
        var d = New();
        d.Observe(At(1000));

        var gap = d.Observe(new SleepGapDetector.Sample(500_000, 400_000, T0.AddSeconds(1001)));

        Assert.True(gap.SleptFor >= TimeSpan.Zero);
    }

    [Fact]
    public void After_Reset_the_next_sample_is_treated_as_the_first()
    {
        var d = New();
        d.Observe(At(100));
        d.Reset();

        // without a Reset this would show a huge gap
        Assert.False(d.Observe(At(9999)).Detected);
    }
}
