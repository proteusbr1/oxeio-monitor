namespace oXeio.Core.Agent;

/// <summary>
/// Whether the agent should be counting time right now: <b>one place only</b>.
///
/// <b>Why this was written:</b> after install the sign-in window appeared, but the agent
/// started counting <b>before</b> staff signed in: a green "Working" in the tray, and rows
/// piling up in the outbox. Three separate harms:
/// <list type="number">
///   <item><b>Hours under the wrong person.</b> If an admin set up the PC and worked on it
///   for half an hour, that time sat in the outbox, and the moment staff signed in later the
///   device was bound to their name, putting someone else's half hour in their record.</item>
///   <item><b>Pictures before consent.</b> The screenshot rule is "while working", but
///   someone who has not even signed in yet is not anybody yet.</item>
///   <item><b>The window lied.</b> A green dot and "Working" mean everything is fine; in
///   fact not one byte could reach the server.</item>
/// </list>
///
/// In Core this is a three-line pure decision; inside <c>AgentHost</c>'s thread loop,
/// verifying it would need a real machine, a real login and waiting.
/// </summary>
public static class TrackingGate
{
    public enum Verdict
    {
        Allowed,

        /// <summary>
        /// Not signed in yet: there is no basis for counting, because it is not yet known
        /// <b>whose</b> hours these are.
        /// </summary>
        NotEnrolled,

        /// <summary>H06: the office has switched this device off.</summary>
        Revoked,
    }

    /// <summary>
    /// <b>The order is the real decision here: revoke first.</b>
    ///
    /// Revoking makes <c>DeviceCredentials</c> delete the token, so from that moment the
    /// device is also "not enrolled": both conditions are true. In the opposite order, staff
    /// on a revoked machine would see <i>"Sign in to start"</i>, being told to turn back on
    /// what the office has shut off.
    ///
    /// (Not a real gap: <c>NeedsEnrollment</c> itself returns false once revoked, so the
    /// window never appears. But the <b>message</b> would have been wrong, and on a revoked
    /// device that one line is staff's only explanation.)
    /// </summary>
    public static Verdict Check(bool enrolled, bool revoked)
    {
        if (revoked) return Verdict.Revoked;
        if (!enrolled) return Verdict.NotEnrolled;

        return Verdict.Allowed;
    }

    public static bool Allows(bool enrolled, bool revoked) =>
        Check(enrolled, revoked) == Verdict.Allowed;

    /// <summary>
    /// What staff will read. Every sentence says <b>what to do</b>, not only what is not
    /// happening. This one tray line is their only explanation.
    /// </summary>
    public static string Explain(Verdict verdict) => verdict switch
    {
        // "What to do" is not enough: where to do it is needed too. This used to say
        // only "Sign in to start counting your hours", and the window had no sign-in button at
        // all. The owner caught exactly this. An instruction that shows no way to follow it
        // is not an instruction; it is just blame.
        Verdict.NotEnrolled =>
            "Sign in to start counting your hours — right-click the oXeio tray icon → Sign in",
        Verdict.Revoked => "This device has been switched off — tell the office",
        _ => "Counting your hours",
    };
}
