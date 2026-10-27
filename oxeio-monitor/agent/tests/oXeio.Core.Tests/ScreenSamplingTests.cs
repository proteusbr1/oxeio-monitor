using oXeio.Core.Capture;
using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>G46: when the screen fingerprint is taken.</b>
///
/// Careful: this file exists for <b>one reason</b>: in 0.4.1 the fingerprint came from
/// the screenshot slot, and the slot ran only while ACTIVE. So the penalty for freezing
/// became its own proof, with no way out.
/// </summary>
public class ScreenSamplingTests
{
    private static readonly DateTimeOffset Start =
        new(2026, 8, 17, 4, 0, 0, TimeSpan.Zero); // 10 AM local (UTC+6 in tests)

    private static DateTimeOffset At(int seconds) => Start.AddSeconds(seconds);

    // ── when ────────────────────────────────────────────────────────────────

    /// <summary>Always the first time: there is nothing to compare against</summary>
    [Fact]
    public void First_sample_is_always_due()
    {
        Assert.True(ScreenSampling.Due(At(0), null, frozen: false));
    }

    [Fact]
    public void Not_due_before_the_interval()
    {
        Assert.False(ScreenSampling.Due(At(59), At(0), frozen: false));
        Assert.True(ScreenSampling.Due(At(60), At(0), frozen: false));
    }

    /// <summary>
    /// <b>Much more often when frozen:</b> this is where fairness lives.
    ///
    /// Frozen means the worker is not being counted. When they return and start working
    /// this must be noticed within seconds, otherwise a minute of time would be cut
    /// after every break: every day, for everyone.
    /// </summary>
    [Fact]
    public void Frozen_screens_are_sampled_much_faster()
    {
        Assert.False(ScreenSampling.Due(At(4), At(0), frozen: true));
        Assert.True(ScreenSampling.Due(At(5), At(0), frozen: true));
    }

    /// <summary>
    /// Careful: if the clock goes back (NTP) a sample is still taken; stopping would cost more
    /// </summary>
    [Fact]
    public void Clock_going_backwards_still_samples()
    {
        Assert.True(ScreenSampling.Due(At(0), At(600), frozen: false));
    }

    /// <summary>
    /// Careful: the interval must be well below
    /// <see cref="ScreenActivity.StaleAfter"/>. Otherwise samples would go stale in the
    /// middle of normal work, and the whole guard would sit <b>silently useless</b>, the
    /// most familiar mistake in this project.
    /// </summary>
    [Fact]
    public void Interval_leaves_room_before_a_sample_goes_stale()
    {
        Assert.True(ScreenSampling.Interval * 2 < ScreenActivity.StaleAfter);
        Assert.True(ScreenSampling.WhenFrozen < ScreenSampling.Interval);
    }

    // ── when allowed ────────────────────────────────────────────────────────

    [Fact]
    public void Allowed_in_the_normal_case()
    {
        Assert.True(ScreenSampling.Allowed(
            enrolled: true, revoked: false, insideWindow: true, locked: false, displayOff: false));
    }

    [Fact]
    public void Not_allowed_before_sign_in_or_after_revoke()
    {
        Assert.False(ScreenSampling.Allowed(false, false, true, false, false));
        Assert.False(ScreenSampling.Allowed(true, true, true, false, false));
    }

    /// <summary>Careful: outside office hours the screen is not touched at all (§ 4.2)</summary>
    [Fact]
    public void Not_allowed_outside_the_window()
    {
        Assert.False(ScreenSampling.Allowed(
            true, false, insideWindow: false, locked: false, displayOff: false));
    }

    /// <summary>
    /// Careful: a locked screen is static anyway. Keeping it as a sample would make the
    /// screen look "frozen" for a while even after unlock, and cut the time of someone
    /// returning from lunch.
    /// </summary>
    [Fact]
    public void Not_allowed_while_locked()
    {
        Assert.False(ScreenSampling.Allowed(true, false, true, locked: true, displayOff: false));
    }

    /// <summary>
    /// Careful: with the monitors asleep nobody can be looking, and a dark screen never changes,
    /// so it is the frozen case: without this rule every screen was captured every 5 seconds all
    /// night on an unlocked PC.
    /// </summary>
    [Fact]
    public void Not_allowed_while_the_display_is_off()
    {
        Assert.False(ScreenSampling.Allowed(
            enrolled: true, revoked: false, insideWindow: true, locked: false, displayOff: true));
    }

    /// <summary>
    /// <b>Skipping while dark must not punish the employee who comes back.</b> No samples while
    /// dark → stale → "don't know", never frozen. After waking, the comparison is against the
    /// last sample before the display went off, the same one uninterrupted sampling of a dark
    /// screen would have kept, so the rule changes no verdict, it only delays it.
    /// </summary>
    [Fact]
    public void Skipping_while_dark_goes_stale_and_does_not_freeze()
    {
        var screen = new ScreenActivity();
        var still = new byte[256];

        // working, then the screen stays still for a while before the monitors sleep
        screen.Observe(still, At(0));
        screen.Observe(still, At(60));

        // dark from 60 s to 20 min: sampling skipped, nothing observed
        Assert.False(ScreenSampling.Allowed(true, false, true, false, displayOff: true));

        // the last sample is long stale: no accusation, even though nothing changed for 20 min
        Assert.False(screen.IsFrozen(At(20 * 60)));

        // woken; an unchanged first sample gives the same answer as if sampling had never stopped
        Assert.True(ScreenSampling.Allowed(true, false, true, false, displayOff: false));
        screen.Observe(still, At(20 * 60 + 30));
        Assert.True(screen.IsFrozen(At(20 * 60 + 30)));

        // and the first real change lifts it at once
        var moved = new byte[256];
        Array.Fill(moved, (byte)200);
        screen.Observe(moved, At(20 * 60 + 35));
        Assert.False(screen.IsFrozen(At(20 * 60 + 35)));
    }

    /// <summary>
    /// <b>The main test of this file: so that the deadlock can never return.</b>
    ///
    /// In exactly the state where <see cref="CaptureGate"/> does not allow a screenshot
    /// (IDLE, and it is right to refuse: screenshots are stored and viewed), the
    /// fingerprint is <b>still taken</b>. The fingerprint is stored nowhere; it is
    /// just the answer to one question: <i>is the screen changing?</i>
    ///
    /// Careful: without both claims together the same trap returns: frozen -> IDLE ->
    /// fingerprint stops -> frozen forever.
    /// </summary>
    [Fact]
    public void Sampling_continues_exactly_where_screenshots_stop()
    {
        var window = CaptureWindow.Default;
        var at = Start;

        // screenshots stop: the worker is idle
        Assert.Equal(
            CaptureGate.Verdict.NotActive,
            CaptureGate.Check(SegmentState.Idle, enrolled: true, revoked: false, window, at));

        // but the fingerprint is still taken
        Assert.True(ScreenSampling.Allowed(
            enrolled: true, revoked: false, insideWindow: true, locked: false, displayOff: false));
    }

    /// <summary>
    /// ⚠️ Turning screenshots off must not turn the jiggler check off: if it
    /// did, a frozen screen would keep counting as work and hours would change.
    /// </summary>
    [Fact]
    public void Screenshots_off_by_policy_keep_the_screen_sampled()
    {
        Assert.Equal(
            CaptureGate.Verdict.DisabledByPolicy,
            CaptureGate.Check(SegmentState.Active, enrolled: true, revoked: false,
                CaptureWindow.Default, Start, screenshotsEnabled: false));

        // the sampling rule does not even take the flag — nothing to switch off
        Assert.True(ScreenSampling.Allowed(
            enrolled: true, revoked: false, insideWindow: true, locked: false, displayOff: false));
    }
}
