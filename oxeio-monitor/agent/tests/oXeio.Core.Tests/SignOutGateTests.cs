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
    public void Sign_out_is_allowed_when_signed_in() =>
        Assert.True(SignOutGate.Allows(Enrolled, NotRevoked, Nothing));

    [Fact]
    public void Nothing_to_sign_out_of_when_not_signed_in() =>
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
    public void On_a_revoked_device_the_answer_is_revoked_not_not_signed_in()
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
    public void Sign_out_is_disabled_on_a_revoked_device() =>
        Assert.False(SignOutGate.Allows(NotEnrolled, Revoked, Something));

    /** The main test of this file */
    [Fact]
    public void Unsent_rows_give_a_distinct_verdict()
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
    public void A_negative_count_is_treated_as_nothing() =>
        Assert.Equal(
            SignOutGate.Verdict.Ready,
            SignOutGate.Check(Enrolled, NotRevoked, -3));

    [Fact]
    public void A_single_row_is_enough() =>
        Assert.Equal(
            SignOutGate.Verdict.PendingUpload,
            SignOutGate.Check(Enrolled, NotRevoked, 1));

    /**
     * Careful: the message is persuading staff to <b>throw data away</b>. So three
     * things must be in it: how many, what will happen, and the way out.
     */
    [Fact]
    public void With_unsent_rows_the_message_has_count_loss_and_way_out()
    {
        var text = SignOutGate.Confirm(SignOutGate.Verdict.PendingUpload, Something);

        Assert.Contains("7", text, StringComparison.Ordinal);
        Assert.Contains("discard", text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Sync now", text, StringComparison.Ordinal);
    }

    /** Careful: "1 items": any sign of carelessness makes the whole warning less believable */
    [Fact]
    public void Singular_and_plural_are_worded_differently()
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
    public void When_everything_is_sent_the_message_does_not_alarm()
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
    public void Asking_for_a_message_in_a_disabled_state_throws(SignOutGate.Verdict verdict) =>
        Assert.Throws<ArgumentOutOfRangeException>(
            () => SignOutGate.Confirm(verdict, Nothing));
}
