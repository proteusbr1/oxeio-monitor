using System.Runtime.Versioning;

using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Security;

/// <summary>
/// The only implementation of <see cref="IDeviceCredentials"/>: it brings
/// <see cref="DeviceTokenStore"/> (disk) and <see cref="MachineIdentity"/> (machine) together in
/// one place and gives them to the rest of the agent.
///
/// Careful: the whole state is under one <c>lock</c>. Enroll (startup thread), read (sync worker)
/// and revoke (the heartbeat reply): three threads touch the same fields. <c>volatile</c> would not
/// do, because the token and deviceId must change together; changed separately, a new token and an
/// old deviceId would pair up for a moment.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DeviceCredentials : IDeviceCredentials, IDeviceTokenSource
{
    private readonly object _gate = new();
    private readonly DeviceTokenStore _store;
    private readonly Action<string>? _log;

    private DeviceCredentialRecord? _record;
    private CredentialLoadStatus _status = CredentialLoadStatus.NotEnrolled;
    private string? _detail;
    private bool _revoked;

    private DeviceCredentials(DeviceTokenStore store, MachineIdentity identity, Action<string>? log)
    {
        _store = store;
        Identity = identity;
        _log = log;
    }

    /// <summary>Once at startup. Careful: does not throw; the agent starts even if the disk is
    /// corrupt.</summary>
    public static DeviceCredentials Open(
        DeviceTokenStore store, MachineIdentity identity, Action<string>? log = null)
    {
        var credentials = new DeviceCredentials(store, identity, log);
        credentials.Reload();
        return credentials;
    }

    public MachineIdentity Identity { get; }

    public event Action<IDeviceCredentials>? Changed;

    public bool IsEnrolled
    {
        get { lock (_gate) return !_revoked && _record is not null; }
    }

    public bool IsRevoked
    {
        get { lock (_gate) return _revoked; }
    }

    public bool NeedsEnrollment
    {
        get { lock (_gate) return !_revoked && _record is null && Identity.UsableForEnrollment; }
    }

    public int? DeviceId
    {
        get { lock (_gate) return _record?.DeviceId; }
    }

    public EnrolledEmployee? Employee
    {
        get { lock (_gate) return _record?.Employee; }
    }

    public string? TokenFingerprint
    {
        get { lock (_gate) return _record?.Token.Fingerprint; }
    }

    public CredentialLoadStatus Status
    {
        get { lock (_gate) return _status; }
    }

    public string? Detail
    {
        get { lock (_gate) return _detail; }
    }

    /// <summary>
    /// Pushes the token into <see cref="ISyncClient"/>. It does not stop on the way in any
    /// variable, log or return value: one of the four permitted call sites of
    /// <see cref="SecretText.Reveal"/>.
    /// </summary>
    public void ApplyTo(ISyncClient client)
    {
        ArgumentNullException.ThrowIfNull(client);

        string? token;
        lock (_gate)
        {
            token = _revoked ? null : _record?.Token.Reveal();
        }

        client.SetDeviceToken(token);
    }

    /// <summary>
    /// <see cref="HttpSyncClient"/>'s preferred connection: on each request it takes the token from
    /// here itself, so after enroll or revoke nobody has to be pushed separately.
    ///
    /// Careful: an explicit implementation. If a <c>string? CurrentToken</c> hung on
    /// <see cref="DeviceCredentials"/>'s ordinary surface, it would end up in a log one day. Unless
    /// it is taken as <see cref="IDeviceTokenSource"/> it is not even visible.
    ///
    /// Careful: no disk read, no DPAPI: only the value cached under the lock. Their contract says
    /// so explicitly, and calling DPAPI on every request would make the upload loop eat the CPU.
    /// </summary>
    string? IDeviceTokenSource.CurrentToken
    {
        get { lock (_gate) return _revoked ? null : _record?.Token.Reveal(); }
    }

    public bool Reload()
    {
        bool changed;
        CredentialLoadStatus status;
        string? detail;

        lock (_gate)
        {
            // Careful: on a revoked device the disk is not read again. If it were, and someone
            // brought back an old device.dat, a revoked device would quietly start tracking again,
            // the opposite of H06.
            if (_revoked) return false;

            var load = _store.Load(Identity);
            var previousFingerprint = _record?.Token.Fingerprint;

            _status = load.Status;
            _detail = load.Detail;
            _record = load.Status == CredentialLoadStatus.Loaded ? load.Record : null;

            changed = previousFingerprint != _record?.Token.Fingerprint;
            status = _status;
            detail = _detail;
        }

        if (status is CredentialLoadStatus.Unreadable or CredentialLoadStatus.BindingMismatch)
            _log?.Invoke($"⚠️ Credentials: {status} — {detail}");

        if (changed) RaiseChanged();
        return changed;
    }

    /// <summary>
    /// Called <b>after</b> a successful enroll has been written to disk. Careful: if the order were
    /// reversed (memory first, then disk), the agent would run happily even if the disk write
    /// failed, and after a reboot the token would be gone, by which time the server has forgotten
    /// that one-time token too.
    /// </summary>
    internal void Adopt(DeviceCredentialRecord record)
    {
        lock (_gate)
        {
            _record = record;
            _status = CredentialLoadStatus.Loaded;
            _detail = null;
            _revoked = false;
        }

        RaiseChanged();
    }

    public void Revoke(string reason)
    {
        lock (_gate)
        {
            if (_revoked) return;

            _revoked = true;
            _record = null;
            _status = CredentialLoadStatus.NotEnrolled;
            _detail = "This device has been revoked: " + reason;
        }

        _store.TryDelete("revoke — " + reason);
        _log?.Invoke($"⛔ Device revoked: {reason}. Tracking is permanently stopped.");

        RaiseChanged();
    }

    /// <summary>
    /// When the staff member signs out themselves.
    ///
    /// Careful: <b>the only but decisive difference from <see cref="Revoke"/>: <c>_revoked</c> is
    /// not touched.</b> So <see cref="NeedsEnrollment"/> becomes true again and the sign-in window
    /// comes back. Calling revoke would leave the machine stuck in the "office has shut it down"
    /// state, when the office did nothing.
    ///
    /// Careful: if <c>Identity.UsableForEnrollment</c> is false, <see cref="NeedsEnrollment"/>
    /// stays false anyway; that is fine, because signing in could not have worked on that machine
    /// the first time either.
    /// </summary>
    public void SignOut(string reason)
    {
        lock (_gate)
        {
            // Careful: already signed out (or never signed in): there is nothing to do. Even so,
            // TryDelete is not called, otherwise every menu click would write to disk for nothing.
            if (_record is null) return;

            _record = null;
            _status = CredentialLoadStatus.NotEnrolled;
            _detail = "Signed out: " + reason;
        }

        _store.TryDelete("sign out — " + reason);
        _log?.Invoke($"👋 Signed out: {reason}. Tracking stops until someone signs in.");

        RaiseChanged();
    }

    /// <summary>
    /// Careful: handler exceptions are swallowed. A broken subscriber in the sync module must not
    /// block the enroll or revoke path: if revoke were blocked, a revoked device would keep
    /// tracking.
    /// </summary>
    private void RaiseChanged()
    {
        var handlers = Changed;
        if (handlers is null) return;

        foreach (var handler in handlers.GetInvocationList().Cast<Action<IDeviceCredentials>>())
        {
            try
            {
                handler(this);
            }
            catch (Exception ex)
            {
                _log?.Invoke($"⚠️ credentials Changed handler failed: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    /// <summary>One line to show in the tray/log: nothing secret.</summary>
    public string Describe()
    {
        lock (_gate)
        {
            if (_revoked) return "revoked";
            if (_record is null) return $"not enrolled — {_status}{(_detail is null ? "" : ": " + _detail)}";

            return $"device #{_record.DeviceId} · {_record.Employee.EmpCode} " +
                   $"({_record.Employee.FullName}) · token {_record.Token.Fingerprint}";
        }
    }
}
