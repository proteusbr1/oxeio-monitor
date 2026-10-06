namespace oXeio.Core.Agent;

/// <summary>
/// Whether signing out is allowed right now, and if so <b>what would be lost</b>. The pair
/// of <see cref="TrackingGate"/>.
///
/// <b>Why this is a rule, not just a menu item:</b> signing out deletes the device token. But
/// whatever is still in the outbox (segments, app usage, screenshots) <b>stays on disk</b>. If
/// the next person signs in on the same PC, the sync worker would send those with <b>their</b>
/// token, and the previous person's hours and pictures would land in the new person's record.
///
/// This is the same harm as <b>G79</b>, from the opposite side. In G79 the rows from <i>before</i>
/// sign-in went to the wrong person; here it is the sign-in <i>after</i> a sign-out. So the
/// fix has the same shape: the decision lives in Core, pure, and every caller follows the same rule.
///
/// So rows not yet sent at sign-out time must be <b>discarded</b>. Losing data is bad, but
/// <b>data landing under the wrong person is worse</b>: staff notice the first (fewer hours),
/// while nobody ever notices the second.
/// </summary>
public static class SignOutGate
{
    public enum Verdict
    {
        /// <summary>Nobody has signed in: the menu item is visible but disabled.</summary>
        NotSignedIn,

        /// <summary>
        /// H06: the office has shut this device off. The token is already gone, so there is
        /// nothing to sign out of.
        /// </summary>
        Revoked,

        /// <summary>Everything has been sent: go straight ahead after a confirmation.</summary>
        Ready,

        /// <summary>
        /// There are rows in the outbox. Signing out is allowed, but they will be discarded,
        /// so the count must be shown to staff and they must be asked.
        /// </summary>
        PendingUpload,
    }

    /// <param name="pendingItems">
    /// The number of rows still in the outbox (<c>OutboxDepth.Total</c>).
    /// Negative or zero both mean "nothing". A counting bug must not produce an unnecessary
    /// warning; staff should not be punished for a bug.
    /// </param>
    /// <remarks>
    /// <b>The order is exactly the same as <see cref="TrackingGate.Check"/>: revoke first.</b>
    /// Revoking deletes the token, so "not enrolled" is true as well and both conditions hold.
    /// Written the other way round, staff on a revoked machine would see
    /// <i>"not signed in"</i>, when the real news is that the office shut it off.
    /// If two gates gave different answers, two places in the tray would explain it differently.
    /// </remarks>
    public static Verdict Check(bool enrolled, bool revoked, int pendingItems)
    {
        if (revoked) return Verdict.Revoked;
        if (!enrolled) return Verdict.NotSignedIn;

        return pendingItems > 0 ? Verdict.PendingUpload : Verdict.Ready;
    }

    /// <summary>Whether the menu item will be <c>Enabled</c>.</summary>
    public static bool Allows(Verdict verdict) =>
        verdict is Verdict.Ready or Verdict.PendingUpload;

    public static bool Allows(bool enrolled, bool revoked, int pendingItems) =>
        Allows(Check(enrolled, revoked, pendingItems));

    /// <summary>
    /// The text of the confirmation window.
    ///
    /// <b>There is no text for the disabled state</b>: when <see cref="Allows(Verdict)"/> is
    /// false the window never opens. Putting a message here would one day get shown, and staff
    /// would read a "confirm?" prompt that has no effect.
    /// </summary>
    /// <exception cref="ArgumentOutOfRangeException">
    /// A verdict in which signing out is not possible at all.
    /// </exception>
    public static string Confirm(Verdict verdict, int pendingItems) => verdict switch
    {
        // The words "you can sign in again" are deliberate. Without them staff would think
        // signing out means being removed for good (revoke), and out of fear nobody would sign
        // out on a shared PC, so hours would land under the wrong person.
        Verdict.Ready =>
            "Sign out of oXeio?\n\n"
            + "Your hours stop being counted until someone signs in again. "
            + "Everything measured so far has already reached the office.",

        // The count goes at the **start** of the sentence, because it is the one thing that can
        // change staff's decision. And it says "Sync now"; otherwise the message would only
        // report the loss, not the way to avoid it.
        Verdict.PendingUpload =>
            $"{Describe(pendingItems)} not reached the office yet.\n\n"
            + "Signing out now will discard them — they cannot be sent later, "
            + "because the next person to sign in would get them counted as theirs.\n\n"
            + "If you are online, close this and choose \"Sync now\" first.\n\n"
            + "Sign out and discard?",

        _ => throw new ArgumentOutOfRangeException(
            nameof(verdict), verdict, "Sign out is not available in this state"),
    };

    /// <summary>
    /// Singular/plural handled separately. "1 items" looks minor, but this very sentence is
    /// what persuades staff to discard data; any sign of carelessness here makes the whole
    /// warning less believable.
    /// </summary>
    private static string Describe(int pendingItems) =>
        pendingItems == 1 ? "1 measurement has" : $"{pendingItems} measurements have";
}
