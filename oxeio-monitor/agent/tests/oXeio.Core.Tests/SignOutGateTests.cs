using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// Whether signing out is allowed, and what is lost if you do.
///
/// Careful: the real job of this rule is not disabling a menu; it is <b>preventing
/// hours from landing under the wrong person's name</b>. If rows were left in the
/// outbox after sign-out, they would go out under the next person's token the moment
/// they sign in, and nobody would ever notice. So the boundaries here matter most.
/// </summary>
public class SignOutGateTests
{
    private const bool Enrolled = true;
    private const bool NotEnrolled = false;
    private const bool Revoked = true;
    private const bool NotRevoked = false;

    private const int Nothing = 0;
    private const int Something = 7;

    [Fact]
    public void সাইন_ইন_করা_থাকলে_সাইন_আউট_করা_যায়() =>
        Assert.True(SignOutGate.Allows(Enrolled, NotRevoked, Nothing));

    [Fact]
    public void সাইন_ইন_না_থাকলে_সাইন_আউটের_কিছু_নেই() =>
        Assert.Equal(
            SignOutGate.Verdict.NotSignedIn,
            SignOutGate.Check(NotEnrolled, NotRevoked, Nothing));

    /**
     * Careful: <b>the order test; it matches TrackingGate exactly.</b>
     *
     * On revoke the token is deleted, so "not enrolled" is true at that moment too.
     * Both conditions hold, which is why the order must be written down; otherwise
     * staff on a revoked machine would see "not signed in", when the real fact is that
     * the office switched it off.
     *
     * If the two gates did not follow the same order, the two places in the tray would
     * give two different explanations.
     */
    [Fact]
    public void বাতিল_ডিভাইসে_revoke_ই_উত্তর_সাইন_ইন_নেই_নয()
    {
        Assert.Equal(
            SignOutGate.Verdict.Revoked,
            SignOutGate.Check(NotEnrolled, Revoked, Nothing));

        // both gates have the same order: this is the real claim
        Assert.Equal(
            TrackingGate.Verdict.Revoked,
            TrackingGate.Check(NotEnrolled, Revoked));
    }

    [Fact]
    public void বাতিল_ডিভাইসে_সাইন_আউট_নিষ্ক্রিয়() =>
        Assert.False(SignOutGate.Allows(NotEnrolled, Revoked, Something));

    /** The main test of this file */
    [Fact]
    public void অপাঠানো_সারি_থাকলে_আলাদা_উত্তর()
    {
        Assert.Equal(
            SignOutGate.Verdict.PendingUpload,
            SignOutGate.Check(Enrolled, NotRevoked, Something));

        // Careful: it does not block, it only asks. Blocking would mean nobody could
        // ever sign out on an offline machine, and on a shared PC hours would go to the
        // wrong person, exactly what we are trying to prevent.
        Assert.True(SignOutGate.Allows(Enrolled, NotRevoked, Something));
    }

    /**
     * Careful: a bug in the count must not produce an extra warning: a negative number
     * equals "nothing". Staff should not pay for a bug.
     */
    [Fact]
    public void ঋণাত্মক_গণনা_কিছু_নেই_ধরা_হয() =>
        Assert.Equal(
            SignOutGate.Verdict.Ready,
            SignOutGate.Check(Enrolled, NotRevoked, -3));

    [Fact]
    public void একটা_সারিও_যথেষ্ট() =>
        Assert.Equal(
            SignOutGate.Verdict.PendingUpload,
            SignOutGate.Check(Enrolled, NotRevoked, 1));

    /**
     * Careful: the message is persuading staff to <b>throw data away</b>. So three
     * things must be in it: how many, what will happen, and the way out.
     */
    [Fact]
    public void অপাঠানো_থাকলে_বার্তায়_সংখ্যা_ক্ষতি_ও_পথ_তিনটেই_থাকে()
    {
        var text = SignOutGate.Confirm(SignOutGate.Verdict.PendingUpload, Something);

        Assert.Contains("7", text, StringComparison.Ordinal);
        Assert.Contains("discard", text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Sync now", text, StringComparison.Ordinal);
    }

    /** Careful: "1 items": any sign of carelessness makes the whole warning less believable */
    [Fact]
    public void একবচন_ও_বহুবচন_আলাদা()
    {
        var one = SignOutGate.Confirm(SignOutGate.Verdict.PendingUpload, 1);
        var many = SignOutGate.Confirm(SignOutGate.Verdict.PendingUpload, 5);

        Assert.Contains("1 measurement has", one, StringComparison.Ordinal);
        Assert.Contains("5 measurements have", many, StringComparison.Ordinal);
    }

    /**
     * Careful: it is important to convey "you can sign in again". If not, staff would
     * think signing out means being removed for good, and out of fear nobody would sign
     * out on a shared PC; then hours would go to the wrong person.
     */
    [Fact]
    public void সব_পাঠানো_হয়ে_গেলে_বার্তা_ভয়_দেখায়_না()
    {
        var text = SignOutGate.Confirm(SignOutGate.Verdict.Ready, Nothing);

        Assert.Contains("signs in again", text, StringComparison.Ordinal);
        Assert.DoesNotContain("discard", text, StringComparison.OrdinalIgnoreCase);
    }

    /**
     * Careful: in a state where signing out is not possible at all, asking for a
     * message is the caller's mistake; silently returning a line would show staff a
     * "confirm?" that has no consequence.
     */
    [Theory]
    [InlineData(SignOutGate.Verdict.NotSignedIn)]
    [InlineData(SignOutGate.Verdict.Revoked)]
    public void নিষ্ক্রিয়_অবস্থায়_বার্তা_চাইলে_ছুঁড়ে_দেয(SignOutGate.Verdict verdict) =>
        Assert.Throws<ArgumentOutOfRangeException>(
            () => SignOutGate.Confirm(verdict, Nothing));
}
