using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// Whether time is counted: sign-in and revoke.
///
/// Careful: this file was written because of a field bug: after 0.3.3 the sign-in
/// window appeared, but <b>even when not signed in</b> the tray showed a green
/// "Working" and 7 rows piled up in the outbox.
/// </summary>
public class TrackingGateTests
{
    private const bool Enrolled = true;
    private const bool NotEnrolled = false;
    private const bool Revoked = true;
    private const bool NotRevoked = false;

    [Fact]
    public void সাইন_ইন_করা_থাকলে_গোনা_চলে() =>
        Assert.True(TrackingGate.Allows(Enrolled, NotRevoked));

    /**
     * The main test of this file. If counting started before sign-in, the time would
     * pile up in the outbox, and the moment staff signed in the device would be bound
     * to their name and that time would go into their ledger too: half an hour of the
     * admin's time on someone else's attendance.
     */
    [Fact]
    public void সাইন_ইন_না_করা_থাকলে_গোনা_নয়() =>
        Assert.Equal(
            TrackingGate.Verdict.NotEnrolled,
            TrackingGate.Check(NotEnrolled, NotRevoked));

    [Fact]
    public void বাতিল_ডিভাইসে_গোনা_নয়() =>
        Assert.Equal(
            TrackingGate.Verdict.Revoked,
            TrackingGate.Check(Enrolled, Revoked));

    /**
     * Careful: <b>the order guard.</b> Revoking makes <c>DeviceCredentials</c> delete
     * the token, so from that moment both conditions are true. Written in the other
     * order, staff on a revoked machine would read "Sign in to start", which is an
     * instruction to switch back on what the office switched off.
     */
    [Fact]
    public void দুটোই_সত্যি_হলে_বাতিল_জেতে() =>
        Assert.Equal(
            TrackingGate.Verdict.Revoked,
            TrackingGate.Check(NotEnrolled, Revoked));

    /// <summary>Every state must have a sentence staff can read.</summary>
    [Theory]
    [InlineData(TrackingGate.Verdict.Allowed)]
    [InlineData(TrackingGate.Verdict.NotEnrolled)]
    [InlineData(TrackingGate.Verdict.Revoked)]
    public void প্রতিটা_অবস্থার_ব্যাখ্যা_আছে(TrackingGate.Verdict verdict) =>
        Assert.False(string.IsNullOrWhiteSpace(TrackingGate.Explain(verdict)));

    /**
     * Careful: the message says <b>what to do</b>, not only what is not happening. This
     * one tray line is staff's only explanation; writing "Not enrolled" would leave them
     * unaware that there is anything for them to do.
     */
    [Fact]
    public void সাইন_ইনের_বার্তা_কাজটা_বলে() =>
        Assert.Contains(
            "Sign in",
            TrackingGate.Explain(TrackingGate.Verdict.NotEnrolled),
            StringComparison.Ordinal);

    /**
     * <b>"What to do" is not enough; without "where" it is just blame.</b>
     *
     * In 0.3.4 the screen said in large text "Sign in to start counting your hours",
     * yet the window had no sign-in button at all, and the window appeared only at
     * startup. The owner's reply was one line: there is no option to sign in.
     */
    [Fact]
    public void সাইন_ইনের_বার্তা_কোথায়_সেটাও_বলে() =>
        Assert.Contains(
            "tray",
            TrackingGate.Explain(TrackingGate.Verdict.NotEnrolled),
            StringComparison.OrdinalIgnoreCase);
}
