using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>G46: is the screen really changing?</b>
///
/// Careful: a mistake in this file has two sides, and <b>the second does far more
/// harm</b>:
///   - Too lenient: a jiggler steals hours
///   - <b>Too strict: an honest worker's time gets cut</b>: reading a long document,
///     thinking, talking on the phone; the screen can stay still then
///
/// So the tests that prove "not frozen" matter here at least as much.
/// </summary>
public class ScreenActivityTests
{
    private static readonly DateTimeOffset Start =
        new(2026, 8, 16, 4, 0, 0, TimeSpan.Zero); // 10 AM in Dhaka

    private static DateTimeOffset At(int minutes) => Start.AddMinutes(minutes);

    /// <summary>A 16x16 gray fingerprint: every cell has the same value</summary>
    private static byte[] Flat(byte value) => Enumerable.Repeat(value, 256).ToArray();

    /// <summary>
    /// Samples keep arriving as in real life: the same fingerprint every minute.
    ///
    /// Careful: <b>tests need this, and that is the whole point.</b> With a single
    /// sample "frozen" can no longer be proven; suspicion lifts once
    /// <see cref="ScreenActivity.StaleAfter"/> passes. In the agent a sample arrives every
    /// 60 seconds (every 5 seconds when frozen), so it is the same here.
    /// </summary>
    private static void Steady(ScreenActivity screen, byte value, int fromMin, int toMin)
    {
        for (var m = fromMin; m <= toMin; m++) screen.Observe(Flat(value), At(m));
    }

    /// <summary>The same fingerprint, but with `cells` cells changed by a large amount</summary>
    private static byte[] Nudged(byte value, int cells)
    {
        var f = Flat(value);
        for (var i = 0; i < cells; i++) f[i] = (byte)(value + 90);
        return f;
    }

    /// <summary>
    /// Careful: <b>with no sample it is never "frozen".</b> Capture may be off (at
    /// night), may have failed, or the agent may have just started; treating missing
    /// information as proof would stop counting for the whole team.
    /// </summary>
    [Fact]
    public void No_sample_is_never_frozen()
    {
        var screen = new ScreenActivity();

        Assert.False(screen.IsFrozen(At(0)));
        Assert.False(screen.IsFrozen(At(600)));
        Assert.Null(screen.LastChangedAt);
    }

    /// <summary>
    /// The first sample is itself a "change": there was nothing to compare against before it.
    /// </summary>
    [Fact]
    public void First_sample_counts_as_a_change()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(60), At(0));

        Assert.False(screen.IsFrozen(At(9)));
        Assert.Equal(At(0), screen.LastChangedAt);
    }

    [Fact]
    public void Same_hash_for_ten_minutes_is_frozen()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(100), At(0));
        screen.Observe(Flat(100), At(5));
        screen.Observe(Flat(100), At(10));

        Assert.True(screen.IsFrozen(At(10)));
    }

    /// <summary>
    /// Careful: just before the boundary it is still "not frozen": not a minute earlier.
    /// </summary>
    [Fact]
    public void Just_under_the_window_is_not_frozen()
    {
        var screen = new ScreenActivity();

        Steady(screen, 100, 0, 10);

        Assert.False(screen.IsFrozen(At(9)));
        Assert.True(screen.IsFrozen(At(10)));
    }

    /// <summary>
    /// <b>The main test of this file:</b> a single change restarts the clock. Otherwise
    /// someone who read for ten minutes and then started working would stay uncounted.
    /// </summary>
    [Fact]
    public void A_change_resets_the_clock()
    {
        var screen = new ScreenActivity();

        Steady(screen, 60, 0, 12);
        Assert.True(screen.IsFrozen(At(12)));

        screen.Observe(Flat(100), At(12));   // the screen moved

        Assert.False(screen.IsFrozen(At(12)));

        Steady(screen, 100, 13, 22);
        Assert.False(screen.IsFrozen(At(21)));
        Assert.True(screen.IsFrozen(At(22)));
    }

    /// <summary>Careful: returning to an old hash is also a change: the screen moved.</summary>
    [Fact]
    public void Returning_to_an_old_hash_is_still_a_change()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(60), At(0));
        screen.Observe(Flat(100), At(5));
        screen.Observe(Flat(60), At(10));

        Assert.False(screen.IsFrozen(At(15)));
    }

    /// <summary>
    /// Careful: if the clock goes back (an NTP correction) the calculation turns
    /// negative; it still must not say "frozen", or one time correction would stop
    /// everyone's counting.
    /// </summary>
    [Fact]
    public void Clock_going_backwards_is_not_frozen()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(60), At(30));

        Assert.False(screen.IsFrozen(At(10)));
    }

    /// <summary>The window can be changed: in tests and to change the rule in future</summary>
    [Fact]
    public void Window_is_configurable()
    {
        var screen = new ScreenActivity(TimeSpan.FromMinutes(2));

        screen.Observe(Flat(100), At(0));

        Assert.False(screen.IsFrozen(At(1)));
        Assert.True(screen.IsFrozen(At(2)));
    }

    [Fact]
    public void Zero_window_is_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new ScreenActivity(TimeSpan.Zero));
    }

    /// <summary>The default is 10 minutes: that is the most a jiggler can steal</summary>
    [Fact]
    public void Default_window_is_ten_minutes()
    {
        Assert.Equal(TimeSpan.FromMinutes(10), ScreenActivity.FrozenAfter);
    }

    // ── tolerance: this is where the feature lives or dies ──────────────────

    /// <summary>
    /// <b>The most important test in this file.</b>
    ///
    /// The taskbar clock changes <b>every minute</b>. If an exact match were required,
    /// that one digit alone would be enough: the screen would always show "changing", and
    /// the whole guard would sit <b>silently useless</b>. This kind of silently useless
    /// feature has come back in this project again and again, so it is pinned in a test.
    /// </summary>
    [Fact]
    public void Taskbar_clock_alone_does_not_count_as_a_change()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(100), At(0));
        // the clock digit changed: two cells out of 256
        screen.Observe(Nudged(100, cells: 2), At(5));
        screen.Observe(Nudged(100, cells: 2), At(10));

        Assert.True(screen.IsFrozen(At(10)));
    }

    /// <summary>Real work easily crosses the limit: scrolling, typing, switching windows</summary>
    [Fact]
    public void Real_work_counts_as_a_change()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(100), At(0));
        screen.Observe(Nudged(100, cells: 40), At(5));

        Assert.False(screen.IsFrozen(At(14)));
    }

    /// <summary>Careful: boundary: 5 cells stay frozen, at 6 it is a change</summary>
    [Fact]
    public void Threshold_is_six_cells()
    {
        Assert.False(ScreenActivity.Differs(Flat(100), Nudged(100, cells: 5)));
        Assert.True(ScreenActivity.Differs(Flat(100), Nudged(100, cells: 6)));
    }

    /// <summary>
    /// Careful: small variation (WebP loss, anti-aliasing) is not a change;
    /// otherwise the screen would <b>never</b> count as frozen.
    /// </summary>
    [Fact]
    public void Tiny_noise_everywhere_is_not_a_change()
    {
        var a = Flat(100);
        var b = Flat(100);
        for (var i = 0; i < b.Length; i++) b[i] = (byte)(100 + (i % 2 == 0 ? 10 : -10));

        Assert.False(ScreenActivity.Differs(a, b));
    }

    /// <summary>
    /// Careful: when a monitor is added or removed the fingerprint size itself changes; that is
    /// a change
    /// </summary>
    [Fact]
    public void Different_size_is_a_change()
    {
        Assert.True(ScreenActivity.Differs(Flat(100), new byte[128]));
    }

    // ── stale samples: the mistake that cost one staff member a day ─────────

    /// <summary>
    /// <b>The most valuable test in this file, because it came from real harm.</b>
    ///
    /// In 0.4.1 the fingerprint came only from the screenshot slot, and the slot ran
    /// only while ACTIVE. So: <b>frozen -> IDLE -> slot stops -> no new fingerprint ->
    /// frozen forever</b>. Even when the worker came back and started working, the
    /// agent kept showing idle until a restart.
    ///
    /// Careful: the rule was not wrong; the <b>wiring</b> was. So the remedy is placed
    /// inside the rule: without a fresh sample there is no answer. However the caller
    /// is written, this deadlock can no longer arise.
    /// </summary>
    [Fact]
    public void A_stale_sample_never_freezes()
    {
        var screen = new ScreenActivity();

        // frozen, and the sample is still fresh: the suspicion is valid
        Steady(screen, 100, 0, 11);
        Assert.True(screen.IsFrozen(At(11)));

        // Careful: samples stop (capture paused when IDLE); three minutes later the
        // suspicion is lifted, and counting starts when the worker returns
        Assert.False(screen.IsFrozen(At(15)));
        Assert.False(screen.IsFrozen(At(600)));
    }

    /// <summary>
    /// If samples keep arriving the suspicion holds; otherwise setting StaleAfter would
    /// have made the whole guard useless.
    /// </summary>
    [Fact]
    public void Fresh_samples_keep_the_freeze()
    {
        var screen = new ScreenActivity();

        Steady(screen, 100, 0, 20);

        Assert.True(screen.IsFrozen(At(20)));
    }

    /// <summary>
    /// Careful: the same sample again is "unchanged" but "seen": two different things.
    /// </summary>
    [Fact]
    public void An_unchanged_sample_still_counts_as_seen()
    {
        var screen = new ScreenActivity();

        screen.Observe(Flat(100), At(0));
        screen.Observe(Flat(100), At(12));

        // unchanged, so still frozen; and the sample is fresh, so the answer is given
        Assert.True(screen.IsFrozen(At(12)));
        Assert.Equal(At(0), screen.LastChangedAt);
        Assert.Equal(At(12), screen.LastSampledAt);
    }

    /// <summary>Boundary: at exactly StaleAfter an answer is still given</summary>
    [Fact]
    public void Stale_boundary_is_inclusive()
    {
        var screen = new ScreenActivity();

        Steady(screen, 100, 0, 11);   // last sample at minute 11

        Assert.True(screen.IsFrozen(At(14)));   // exactly 3 minutes old
        Assert.False(screen.IsFrozen(At(15)));  // older than that
    }

    [Fact]
    public void Default_stale_window_is_three_minutes()
    {
        Assert.Equal(TimeSpan.FromMinutes(3), ScreenActivity.StaleAfter);
    }

    [Fact]
    public void Zero_stale_window_is_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new ScreenActivity(staleAfter: TimeSpan.Zero));
    }

    [Fact]
    public void Null_fingerprint_is_rejected()
    {
        var screen = new ScreenActivity();

        // Careful: there are two overloads now, so the type of null must be spelled out
        Assert.Throws<ArgumentNullException>(() => screen.Observe((byte[])null!, At(0)));
        Assert.Throws<ArgumentNullException>(
            () => screen.Observe((IReadOnlyList<byte[]>)null!, At(0)));
    }

    // ════════════════════════════════════════════════════════════════════
    // Multiple monitors.
    //
    // Careful: a field bug. The fingerprint was taken only from the **first** screen,
    // and if someone worked on the second monitor the first stayed still, so after
    // ten minutes: "frozen", and counting stopped. Measured: on three two-monitor PCs
    // over two days, 43, 9 and 6 false idles; on six one-monitor PCs, zero.
    // ════════════════════════════════════════════════════════════════════

    /// <summary>
    /// <b>This test is the real claim: if the second screen changes, it is not frozen
    /// even though the first stays still</b>.
    /// </summary>
    [Fact]
    public void A_change_on_the_second_monitor_means_not_frozen()
    {
        var screen = new ScreenActivity();

        // the first screen stays the same, the second has work going on every minute
        for (var m = 0; m <= 20; m++)
        {
            screen.Observe([Flat(100), Flat((byte)(m * 5))], At(m));
        }

        Assert.False(screen.IsFrozen(At(20)));
    }

    /// <summary>
    /// Careful: the guard stays intact: with a jiggler <b>no</b> screen changes, so
    /// it is caught on two monitors exactly as before.
    /// </summary>
    [Fact]
    public void Frozen_when_neither_of_two_monitors_changes()
    {
        var screen = new ScreenActivity();

        for (var m = 0; m <= 20; m++)
        {
            screen.Observe([Flat(100), Flat(200)], At(m));
        }

        Assert.True(screen.IsFrozen(At(20)));
    }

    /// <summary>
    /// Careful: adding or removing a monitor counts as "changed": someone touched the machine.
    /// </summary>
    [Fact]
    public void A_changed_monitor_count_counts_as_a_change()
    {
        Assert.True(ScreenActivity.DiffersAny([Flat(10)], [Flat(10), Flat(10)]));
        Assert.False(ScreenActivity.DiffersAny([Flat(10)], [Flat(10)]));
    }

    /// <summary>
    /// The old single-screen call works as before; it is now a list of one member.
    /// </summary>
    [Fact]
    public void Single_monitor_behaviour_is_unchanged()
    {
        var screen = new ScreenActivity();

        for (var m = 0; m <= 20; m++) screen.Observe(Flat(100), At(m));

        Assert.True(screen.IsFrozen(At(20)));
    }

    /// <summary>Careful: an empty list means "could not capture anything": not a sample.</summary>
    [Fact]
    public void An_empty_list_is_not_counted_as_a_sample()
    {
        var screen = new ScreenActivity();

        screen.Observe(System.Array.Empty<byte[]>(), At(0));

        // no sample => no suspicion either
        Assert.False(screen.IsFrozen(At(20)));
    }
}
