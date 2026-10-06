using oXeio.Core.Capture;
using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// The four conditions for taking a picture: A04, A04b, H06.
///
/// Careful: the conditions used to be scattered as guard clauses inside
/// <c>AgentHost.CaptureSlotAsync</c>, where no test could reach them. Result: <b>the
/// revoke condition was never written at all</b>, and revoked devices kept taking pictures.
/// </summary>
public class CaptureGateTests
{
    private static readonly CaptureWindow Day = CaptureWindow.Default; // 07:00-23:00

    /// <summary>12:00 noon in Dhaka: inside the window (UTC+6, so 06:00 UTC).</summary>
    private static readonly DateTimeOffset Noon =
        new(2026, 8, 12, 6, 0, 0, TimeSpan.Zero);

    /// <summary>2 AM in Dhaka: outside the window.</summary>
    private static readonly DateTimeOffset Night =
        new(2026, 8, 11, 20, 0, 0, TimeSpan.Zero);

    // Careful: called by name, not with `true`/`false`. With two bools in a row among
    // five parameters, `Check(state, true, false, …)` gives no way to tell which is
    // which, and writing them the wrong way round would still pass the test.
    private const bool Enrolled = true;
    private const bool NotEnrolled = false;
    private const bool Revoked = true;
    private const bool NotRevoked = false;

    [Fact]
    public void সক্রিয়_ও_উইন্ডোর_ভেতরে_হলে_ছবি_ওঠে() =>
        Assert.True(CaptureGate.Allows(SegmentState.Active, Enrolled, NotRevoked, Day, Noon));

    [Theory]
    [InlineData(SegmentState.Idle)]
    [InlineData(SegmentState.Locked)]
    public void ACTIVE_ছাড়া_ছবি_নয়(SegmentState state) =>
        Assert.Equal(
            CaptureGate.Verdict.NotActive,
            CaptureGate.Check(state, Enrolled, NotRevoked, Day, Noon));

    /// <summary>A04b: working at 2 AM counts as time, but no picture is taken.</summary>
    [Fact]
    public void উইন্ডোর_বাইরে_ছবি_নয়() =>
        Assert.Equal(
            CaptureGate.Verdict.OutsideWindow,
            CaptureGate.Check(SegmentState.Active, Enrolled, NotRevoked, Day, Night));

    /// <summary>
    /// H06: this condition was missing until now. On a revoked device only the upload
    /// stopped; pictures were still taken and piled up on a dismissed employee's PC.
    /// </summary>
    [Fact]
    public void বাতিল_ডিভাইসে_ছবি_নয়() =>
        Assert.Equal(
            CaptureGate.Verdict.Revoked,
            CaptureGate.Check(SegmentState.Active, Enrolled, Revoked, Day, Noon));

    /// <summary>
    /// Careful: revoke is checked first. Otherwise the answer to "why was no picture
    /// taken on the revoked device?" would be "it was idle then": true, but not the real reason.
    /// </summary>
    [Fact]
    public void বাতিলের_কারণটাই_আগে_বলা_হয়() =>
        Assert.Equal(
            CaptureGate.Verdict.Revoked,
            CaptureGate.Check(SegmentState.Idle, Enrolled, Revoked, Day, Night));

    /// <summary>Revoke wins even inside the 24-hour window (outside ADR-011c).</summary>
    [Fact]
    public void সবসময়_খোলা_উইন্ডোতেও_বাতিল_আটকায়() =>
        Assert.False(
            CaptureGate.Allows(SegmentState.Active, Enrolled, Revoked, CaptureWindow.Always, Night));

    // ── before sign-in ──────────────────────────────────────────────────────

    /**
     * <b>The mistake right next to revoke.</b> After install, pictures were taken while
     * the sign-in window was still open, yet there is no basis for storing pictures
     * under the name of someone who has not even signed in. The owner caught this in 0.3.3.
     */
    [Fact]
    public void সাইন_ইন_না_করা_থাকলে_ছবি_নয়() =>
        Assert.Equal(
            CaptureGate.Verdict.NotEnrolled,
            CaptureGate.Check(SegmentState.Active, NotEnrolled, NotRevoked, Day, Noon));

    /// <summary>
    /// The reason is stated first too: "it was idle then" is not the real answer.
    /// </summary>
    [Fact]
    public void সাইন_ইনের_কারণটাই_আগে_বলা_হয়() =>
        Assert.Equal(
            CaptureGate.Verdict.NotEnrolled,
            CaptureGate.Check(SegmentState.Idle, NotEnrolled, NotRevoked, Day, Night));

    /**
     * Careful: <b>if both are true, revoke wins</b>, and that is not a hypothetical:
     * revoking deletes the token, so the device is at the same time "not enrolled".
     * The other way round, staff on a revoked machine would be told "sign in", which is
     * asking them to switch on what the office switched off.
     */
    [Fact]
    public void দুটোই_সত্যি_হলে_বাতিলের_কথাই_বলা_হয়() =>
        Assert.Equal(
            CaptureGate.Verdict.Revoked,
            CaptureGate.Check(SegmentState.Active, NotEnrolled, Revoked, Day, Noon));

    // ── screenshot.enabled ───────────────────────────────────────────────────

    [Fact]
    public void Screenshots_on_by_default_change_nothing() =>
        Assert.Equal(
            CaptureGate.Check(SegmentState.Active, Enrolled, NotRevoked, Day, Noon),
            CaptureGate.Check(SegmentState.Active, Enrolled, NotRevoked, Day, Noon, screenshotsEnabled: true));

    [Fact]
    public void Screenshots_off_by_policy_means_no_screenshot_even_when_active() =>
        Assert.Equal(
            CaptureGate.Verdict.DisabledByPolicy,
            CaptureGate.Check(SegmentState.Active, Enrolled, NotRevoked, Day, Noon, screenshotsEnabled: false));

    [Fact]
    public void Revoked_still_wins_over_the_policy() =>
        Assert.Equal(
            CaptureGate.Verdict.Revoked,
            CaptureGate.Check(SegmentState.Active, Enrolled, Revoked, Day, Noon, screenshotsEnabled: false));
}
