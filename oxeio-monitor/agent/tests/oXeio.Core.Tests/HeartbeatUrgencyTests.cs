using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>When the server is told about a state change.</b>
///
/// Careful: this came from the owner's complaint that after returning from idle,
/// "Working" took <b>10-15 seconds</b> to appear on the board. It was not a bug: the
/// agent notices within a second, but the heartbeat went out every 15 seconds.
///
/// The tests here guard two opposite claims together: the change goes out
/// <b>quickly</b>, but the server <b>does not get a flood</b>.
/// </summary>
public class HeartbeatUrgencyTests
{
    private static readonly DateTimeOffset Start =
        new(2026, 8, 17, 4, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(double seconds) => Start.AddSeconds(seconds);

    private static readonly TimeSpan Normal = TimeSpan.FromSeconds(15);

    // ── nothing changed: the normal rhythm ──────────────────────────────────

    [Fact]
    public void Without_a_change_it_waits_the_normal_interval()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(15),
            HeartbeatUrgency.Next(At(0), At(0), Normal, stateChanged: false));
    }

    [Fact]
    public void Without_a_change_only_the_remaining_time_is_waited()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(5),
            HeartbeatUrgency.Next(At(10), At(0), Normal, stateChanged: false));
    }

    [Fact]
    public void An_overdue_beat_goes_at_once()
    {
        Assert.Equal(
            TimeSpan.Zero,
            HeartbeatUrgency.Next(At(20), At(0), Normal, stateChanged: false));
    }

    // ── the state changed ───────────────────────────────────────────────────

    /**
     * <b>The main claim of this file.</b> The moment a worker starts working, the news
     * goes out; no waiting for the next scheduled heartbeat.
     *
     * Careful: the damage is not only delay but trust: the owner sees "Idle" on screen,
     * walks over, and finds the person typing.
     */
    [Fact]
    public void A_state_change_is_reported_at_once()
    {
        Assert.Equal(
            TimeSpan.Zero,
            HeartbeatUrgency.Next(At(5), At(0), Normal, stateChanged: true));
    }

    /**
     * <b>The opposite claim: no flood to the server.</b>
     *
     * Careful: when someone copies notes while reading, the state flips every second.
     * Without a ceiling, 15 PCs would hammer the server constantly for zero gain:
     * to a human eye, 3 seconds and 0 seconds are the same.
     */
    [Fact]
    public void Two_changes_in_a_row_are_not_two_beats_in_a_row()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(3),
            HeartbeatUrgency.Next(At(0), At(0), Normal, stateChanged: true));

        Assert.Equal(
            TimeSpan.FromSeconds(1),
            HeartbeatUrgency.Next(At(2), At(0), Normal, stateChanged: true));
    }

    /// <summary>Careful: boundary, the wait ends exactly at MinGap</summary>
    [Fact]
    public void The_floor_is_exactly_the_min_gap()
    {
        Assert.Equal(
            TimeSpan.Zero,
            HeartbeatUrgency.Next(At(3), At(0), Normal, stateChanged: true));
    }

    [Fact]
    public void The_min_gap_is_three_seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(3), HeartbeatUrgency.MinGap);
    }

    /**
     * A change always makes things <b>faster</b>, never slower.
     *
     * Careful: otherwise a strange state would arise where the news went out even later
     * because the state changed.
     */
    [Theory]
    [InlineData(0)]
    [InlineData(3)]
    [InlineData(7)]
    [InlineData(14)]
    [InlineData(30)]
    public void A_change_never_makes_the_wait_longer(double elapsed)
    {
        var calm = HeartbeatUrgency.Next(At(elapsed), At(0), Normal, stateChanged: false);
        var urgent = HeartbeatUrgency.Next(At(elapsed), At(0), Normal, stateChanged: true);

        Assert.True(urgent <= calm, $"{urgent} > {calm} at {elapsed}s");
    }

    /**
     * Careful: if the clock goes back (an NTP correction) the calculation would be
     * negative and the wait would become <b>huge</b>: the heartbeat would stop for hours
     * and the G01 alert would fire on every machine.
     */
    [Fact]
    public void A_clock_going_backwards_does_not_stall_the_heartbeat()
    {
        var wait = HeartbeatUrgency.Next(At(0), At(600), Normal, stateChanged: false);

        Assert.True(wait <= Normal, $"waited {wait}");
    }
}
