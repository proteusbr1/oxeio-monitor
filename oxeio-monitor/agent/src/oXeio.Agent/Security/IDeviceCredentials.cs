using System.Runtime.Versioning;

using oXeio.Core.Agent;

namespace oXeio.Agent.Security;

/// <summary>
/// The one window through which the sync module looks at the credentials on disk.
///
/// <b>Why the token is not a property here:</b> the sync loop would then have to write
/// <c>SetDeviceToken(credentials.Token)</c>, and right next to it someone would one day
/// write <c>_log($"token={credentials.Token}")</c>. Instead there is <see cref="ApplyTo"/>:
/// the token passes from one hand to the other and never rests anywhere. The implementation
/// also implements <c>oXeio.Agent.Sync.IDeviceTokenSource</c> explicitly so that
/// <c>HttpSyncClient</c> can pull the token itself; that is not visible on this interface.
/// The question "where is the token revealed?" is answered by one grep: <c>Reveal(</c>.
/// The list is in the comment on <see cref="SecretText.Reveal"/>.
///
/// Careful: implementations must be thread-safe. Enrollment happens on the startup thread,
/// reads happen on the sync worker, and revoke arrives in a heartbeat response: three
/// different threads.
/// </summary>
[SupportedOSPlatform("windows")]
internal interface IDeviceCredentials
{
    /// <summary>A token is held and it is valid for this machine.</summary>
    bool IsEnrolled { get; }

    /// <summary>
    /// Enrollment is needed: either it was never done, or the file is no longer usable.
    /// Careful: this is not the opposite of <see cref="IsEnrolled"/>. A revoked device has both
    /// false, because the answer to a revoke is not to enroll again but to stop for good.
    /// </summary>
    bool NeedsEnrollment { get; }

    /// <summary>The server has revoked this device. Tracking will not start again.</summary>
    bool IsRevoked { get; }

    int? DeviceId { get; }

    EnrolledEmployee? Employee { get; }

    /// <summary>An identity that is safe to log (8 hex chars of sha256), not the token.</summary>
    string? TokenFingerprint { get; }

    CredentialLoadStatus Status { get; }

    /// <summary>A human-readable reason; goes to the tray tooltip and the log. Holds no secrets.</summary>
    string? Detail { get; }

    MachineIdentity Identity { get; }

    /// <summary>
    /// Puts the token into <paramref name="client"/>. When not enrolled, <c>null</c> is set,
    /// so the client will get a 401. That is intended: stopping requests that have no token
    /// is not the sync loop's job.
    /// </summary>
    void ApplyTo(ISyncClient client);

    /// <summary>
    /// Re-reads from disk. When the installer enrolls in a separate process (while the agent
    /// was already running), this is how the token arrives. true = the state changed.
    /// </summary>
    bool Reload();

    /// <summary>
    /// On a 403 + <c>{command:"revoke"}</c>. The token is also deleted from disk; otherwise
    /// after a reboot the agent would hit the server again with the revoked token.
    /// </summary>
    void Revoke(string reason);

    /// <summary>
    /// When the staff member signs out from the tray. The token is also deleted from disk.
    ///
    /// Important: <b>this is not <see cref="Revoke"/>, and that difference is the whole point.</b>
    /// Revoke is permanent: <c>IsRevoked</c> becomes true and <see cref="NeedsEnrollment"/>
    /// stays false forever, so the sign-in window never appears again. Sign-out needs the
    /// opposite: the machine should return to the state right after install, so the next
    /// person can sign in.
    ///
    /// Calling <c>Revoke</c> here would be an easy mistake with a silent result: the staff
    /// member would sign out, the tray would then say <i>"This device has been
    /// switched off — tell the office"</i>, and the only way back would be deleting the
    /// token file by hand.
    ///
    /// Careful: unsent outbox rows are <b>not this method's job</b>; <c>AgentHost</c> clears
    /// them first (<see cref="oXeio.Core.Agent.SignOutGate"/>). Doing it here would make the
    /// credentials class know about the outbox and tangle two separate concerns.
    /// </summary>
    void SignOut(string reason);

    /// <summary>
    /// Raised on enroll / reload / revoke. The sync loop sits here and calls
    /// <see cref="ApplyTo"/>, so it does not have to poll.
    ///
    /// Careful: handlers are <b>not</b> called on the UI thread, and their exceptions are
    /// swallowed so that a broken handler cannot block the enrollment path.
    /// </summary>
    event Action<IDeviceCredentials>? Changed;
}
