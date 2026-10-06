using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

using oXeio.Core.Agent;

namespace oXeio.Agent.Security;

/// <summary>The result of reading the credentials from disk.</summary>
internal enum CredentialLoadStatus
{
    /// <summary>All fine, the token is usable.</summary>
    Loaded,

    /// <summary>There is no file: not enrolled yet. This is not an error.</summary>
    NotEnrolled,

    /// <summary>The file exists but could not be opened (DPAPI failed, JSON corrupt, no read
    /// permission).</summary>
    Unreadable,

    /// <summary>
    /// The file opened, but the machineGuid/hostname inside does not match this machine: the token
    /// belongs to another PC. Almost always the result of a disk-image clone.
    /// </summary>
    BindingMismatch,
}

/// <summary>
/// What is stored on disk. Careful: deliberately not a <c>record</c>: a record's generated
/// <c>ToString</c> would print everything, token included. <see cref="Token"/> is itself a
/// <see cref="SecretText"/>, so there are two layers of protection.
/// </summary>
internal sealed class DeviceCredentialRecord
{
    public required int DeviceId { get; init; }
    public required SecretText Token { get; init; }

    /// <summary>This machine's identity at the moment of enrolling: the key for catching
    /// clones.</summary>
    public required string MachineGuid { get; init; }

    /// <inheritdoc cref="MachineGuid"/>
    public required string Hostname { get; init; }

    public required DateTimeOffset EnrolledAt { get; init; }
    public required EnrolledEmployee Employee { get; init; }
    public string? AgentVersion { get; init; }

    public override string ToString() =>
        $"device #{DeviceId} · {Employee.EmpCode} · token={Token} · enrolled {EnrolledAt:u}";
}

/// <summary>The read result. <see cref="Record"/> is filled only for
/// <see cref="CredentialLoadStatus.Loaded"/>.</summary>
internal sealed record CredentialLoad(
    CredentialLoadStatus Status,
    DeviceCredentialRecord? Record,
    string? Detail);

/// <summary>The write result. The enroll reply comes only once, so a failure must not be
/// suppressed.</summary>
internal readonly record struct CredentialSave(bool Ok, string? Detail);

/// <summary>
/// Storing the device token on disk and bringing it back: wrapped with DPAPI (LocalMachine), in
/// %ProgramData%\oXeio\device.dat, with its own ACL.
///
/// <b>1. LocalMachine scope, not CurrentUser, and why:</b>
/// enrollment happens at install time, often in the IT admin's account (or SYSTEM); the agent later
/// runs in the staff account. With CurrentUser scope the blob would be wrapped with the user's
/// DPAPI master key, and <b>no other account could open it at all</b>: the morning after install
/// the agent would get a 401 and sit silent. For the same reason, on a profile reset or password
/// reset (on a non-domain machine the DPAPI master key is destroyed) the token would be lost for
/// good, and a new enrollment code would be needed every time. With LocalMachine scope neither
/// happens.
///
/// <b>2. What LocalMachine scope gives and does not give, honestly:</b> It gives: if the disk is
/// taken out, a backup leaks, or the file is copied to another PC, the token cannot be opened (the
/// DPAPI master key stays on that machine). It does not give: <b>on this</b> PC, any local user who
/// can read the file can also <c>Unprotect</c> it. So the file ACL is the real boundary, not DPAPI.
/// The only way to tighten this is to make the agent a LocalSystem service (then
/// <c>restrictToAdministrators: true</c>); that is a separate decision, not made here.
///
/// <b>3. The ACL that is applied:</b> inheritance off (protected) on the file, then SYSTEM = Full,
/// BUILTIN\Administrators = Full, BUILTIN\Users = <b>Read</b>. Users must get Read, because the
/// agent runs in the staff account while the file is created by an admin. Users have no Write, and
/// no <c>DeleteSubdirectoriesAndFiles</c> on the folder, so an ordinary user cannot delete the
/// token to stop the agent either.
///
/// Careful: if the directory already exists its ACL is <b>not touched</b>: the outbox module writes
/// there too, and changing their deliberate setting would stop data being written on that side.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DeviceTokenStore
{
    /// <summary>Schema version: so that old files can be recognised if the format changes in
    /// future.</summary>
    private const int SchemaVersion = 1;

    public const string DefaultFileName = "device.dat";

    /// <summary>
    /// Credentials that have been revoked are moved here, not deleted. Careful: if deleted, the
    /// question "why is it suddenly asking to re-enroll" would have no answer anywhere.
    /// </summary>
    public const string QuarantineFileName = "device.dat.orphaned";

    /// <summary>
    /// DPAPI's optional entropy. Careful: this is <b>not</b> a secret: it is in the binary. Its one
    /// job: so that another LocalMachine-DPAPI app on the same machine does not open our blob by
    /// mistake. It is not claimed to be "extra security".
    /// </summary>
    private static readonly byte[] Entropy =
        "oXeio.agent.device-credentials.v1"u8.ToArray();

    private readonly Action<string>? _log;
    private readonly bool _restrictToAdministrators;

    public DeviceTokenStore(
        string? directoryPath = null,
        Action<string>? log = null,
        bool restrictToAdministrators = false)
    {
        DirectoryPath = directoryPath ?? DefaultDirectory();
        FilePath = Path.Combine(DirectoryPath, DefaultFileName);
        _log = log;
        _restrictToAdministrators = restrictToAdministrators;
    }

    public string DirectoryPath { get; }

    public string FilePath { get; }

    /// <summary><c>%ProgramData%\oXeio</c>: see <see cref="AgentDataDirectory"/>.</summary>
    public static string DefaultDirectory() => AgentDataDirectory.Default;

    // ── Reading ──────────────────────────────────────────────────────────

    /// <summary>
    /// Careful: never throws. This is the startup path; an exception here would mean the agent did
    /// not start at all, and then nobody on that PC would get hours all month.
    /// </summary>
    public CredentialLoad Load(MachineIdentity identity)
    {
        byte[]? plaintext = null;

        try
        {
            if (!File.Exists(FilePath))
                return new CredentialLoad(CredentialLoadStatus.NotEnrolled, null, null);

            var blob = File.ReadAllBytes(FilePath);
            if (blob.Length == 0)
                return new CredentialLoad(CredentialLoadStatus.Unreadable, null, "the file is empty");

            try
            {
                plaintext = ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.LocalMachine);
            }
            catch (CryptographicException ex)
            {
                // Careful: if we get here, the most likely cause is that the file was copied from
                // another machine (the DPAPI master key did not match), or Windows was reinstalled.
                // Retrying is pointless: a new enroll is needed.
                return new CredentialLoad(
                    CredentialLoadStatus.Unreadable, null,
                    "DPAPI could not unprotect it (the file is probably from another machine): " + ex.Message);
            }

            var record = Parse(plaintext, out var parseError);
            if (record is null)
                return new CredentialLoad(CredentialLoadStatus.Unreadable, null, parseError);

            var mismatch = DescribeBindingMismatch(record, identity);
            if (mismatch is not null)
            {
                Quarantine(mismatch);
                return new CredentialLoad(CredentialLoadStatus.BindingMismatch, null, mismatch);
            }

            return new CredentialLoad(CredentialLoadStatus.Loaded, record, null);
        }
        catch (Exception ex)
        {
            return new CredentialLoad(
                CredentialLoadStatus.Unreadable, null, ex.GetType().Name + ": " + ex.Message);
        }
        finally
        {
            // The less time the plaintext buffer stays in memory, the better. Careful: this does
            // not wipe the token string (a string cannot be wiped): it is defence-in-depth, not a
            // guarantee. See SecretText's comment.
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    /// <summary>
    /// The only reliable place to catch clones.
    ///
    /// In a disk-image clone <b>everything</b> is copied: MachineGuid, the DPAPI master key, even
    /// this device.dat. So clones cannot be recognised by DPAPI or GUID. Exactly one thing is bound
    /// to differ: the <b>hostname</b> (Windows does not allow two machines with the same name on
    /// the network, and after laying an image the name must be changed).
    ///
    /// So if the hostname does not match, the token is not used.
    /// Cost: if someone renames a PC on purpose, one re-enroll is needed. Gain: 15 PCs will not
    /// silently accumulate hours under one person's name. Of the two, the second is irreparable and
    /// the first is five minutes of work, hence this choice.
    /// </summary>
    private static string? DescribeBindingMismatch(DeviceCredentialRecord record, MachineIdentity identity)
    {
        if (!string.Equals(record.MachineGuid, identity.MachineGuid, StringComparison.OrdinalIgnoreCase))
        {
            return $"machineGuid changed (stored {record.MachineGuid}, now {identity.MachineGuid}) — " +
                   "Windows was reinstalled, or the file came from another machine.";
        }

        if (!string.Equals(record.Hostname, identity.Hostname, StringComparison.OrdinalIgnoreCase))
        {
            return $"hostname changed (stored {record.Hostname}, now {identity.Hostname}) — " +
                   "the PC was renamed, or this is a cloned image. Enrol again with a new enrolment code.";
        }

        return null;
    }

    // ── Writing ──────────────────────────────────────────────────────────

    /// <summary>
    /// Careful: the token comes in the enroll reply <b>only once</b> (the server keeps only a
    /// sha256). So if this fails the token is gone for good: the caller must be told loudly that
    /// nothing can be done without a new enrollment code. It must not return false silently.
    /// </summary>
    public CredentialSave Save(DeviceCredentialRecord record)
    {
        byte[]? plaintext = null;

        try
        {
            EnsureDirectory();

            plaintext = Serialize(record);
            var blob = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.LocalMachine);

            WriteAtomic(blob);

            _log?.Invoke($"Credentials saved: {record} → {FilePath}");
            return new CredentialSave(true, null);
        }
        catch (Exception ex)
        {
            // Careful: ex.Message contains no token, and the record's ToString is safe too: even if
            // the record were printed here, only the fingerprint would go.
            return new CredentialSave(false, ex.GetType().Name + ": " + ex.Message);
        }
        finally
        {
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    /// <summary>
    /// Careful: the ACL is applied to a <b>temporary file</b>, then moved. <c>File.Move(...,
    /// overwrite: true)</c> internally uses MoveFileEx/REPLACE_EXISTING: the destination's security
    /// descriptor is discarded and <b>the source's</b> comes along. So setting the ACL on the final
    /// file and then overwriting would silently lose the ACL, and the token would sit with
    /// ProgramData's loose ACL.
    ///
    /// The move itself is atomic on NTFS, so even if the power goes there is no half-written file:
    /// either the old token or the new one.
    /// </summary>
    /// <summary>
    /// Whether the token can really be written: checked <b>before going to the server</b>.
    ///
    /// <b>Why this is needed:</b> an enrollment code is single-use. The server consumes the code,
    /// creates a device and returns the token, <b>once only</b>. If the disk write fails at that
    /// moment, the code is gone, the token is gone, and an orphan device is left on the server. To
    /// fix it an admin must create a new code.
    ///
    /// This is exactly what happened when run on a real machine. So a probe file is written first,
    /// with the same ACL and the same path, to be sure.
    /// </summary>
    public bool CanPersist(out string? error)
    {
        error = null;
        var probe = FilePath + ".probe";

        try
        {
            EnsureDirectory();
            if (File.Exists(probe)) File.Delete(probe);

            // Careful: the real write steps exactly: creating the file, setting the ACL, then
            // writing. Only checking "can the folder be written" would not have caught this bug,
            // because the folder was writable.
            using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            new FileInfo(probe).SetAccessControl(BuildFileSecurity());

            using (var fs = new FileStream(probe, FileMode.Open, FileAccess.Write, FileShare.None))
            {
                fs.WriteByte(0);
            }

            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                       or SystemException)
        {
            error = $"{ex.GetType().Name}: {ex.Message}";
            return false;
        }
        finally
        {
            try { if (File.Exists(probe)) File.Delete(probe); }
            catch (Exception) { /* leaving the probe behind does no harm */ }
        }
    }

    private void WriteAtomic(byte[] blob)
    {
        var temp = FilePath + ".tmp";

        // if leftovers from an earlier attempt are present: if not deleted, the CreateNew below
        // would fail.
        if (File.Exists(temp)) File.Delete(temp);

        // Create an empty file, set the ACL first, then the bytes. In this order the secret bytes
        // never land on disk with the loose inherited ACL.
        using (new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }

        new FileInfo(temp).SetAccessControl(BuildFileSecurity());

        using (var fs = new FileStream(temp, FileMode.Open, FileAccess.Write, FileShare.None))
        {
            fs.Write(blob, 0, blob.Length);

            // Careful: flushToDisk: true, otherwise if power failed right after enroll the file
            // would stay 0 bytes, and the token could never be recovered.
            fs.Flush(flushToDisk: true);
        }

        File.Move(temp, FilePath, overwrite: true);
    }

    private FileSecurity BuildFileSecurity()
    {
        var security = new FileSecurity();

        // Careful: first thing: inheritance off. ProgramData's default ACL gives Authenticated
        // Users write rights; if that were pulled in, any user could change the token file.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, AccessControlType.Allow));

        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            FileSystemRights.FullControl, AccessControlType.Allow));

        if (!_restrictToAdministrators)
        {
            // Careful: this used to be `BUILTIN\Users : Read` here, on the idea that "the installer
            // (admin) writes and the agent (staff) reads". **That idea was wrong**: the agent does
            // the enrollment, not the installer. So the agent created the file, gave itself Read on
            // it, then tried to Write and got "Access denied" on its own file.
            //
            // Caught by running on a real machine: device.dat.tmp had been created, 0 bytes, and
            // the enrollment code had already been consumed.
            //
            // Now **the account the agent is running in** gets Modify. The blanket Read for Users
            // was removed: because of the DPAPI LocalMachine scope, that Read meant any user on
            // that PC could open the token.
            using var me = WindowsIdentity.GetCurrent();
            if (me.User is { } sid)
            {
                security.AddAccessRule(new FileSystemAccessRule(
                    sid, FileSystemRights.Modify, AccessControlType.Allow));
            }
        }

        return security;
    }

    /// <summary>Creates the folder with a strict ACL if it is absent:
    /// <see cref="AgentDataDirectory"/>.</summary>
    private void EnsureDirectory() => AgentDataDirectory.Ensure(DirectoryPath);

    // ── Deleting and moving ──────────────────────────────────────────────

    /// <summary>
    /// When a device is revoked (H06) or the binding is broken. Careful: on NTFS/SSD there is no
    /// such thing as "secure delete" (journal, TRIM, shadow copy), and no attempt is made. The
    /// token is already revoked on the server, so leftover bytes are useless.
    /// </summary>
    public bool TryDelete(string reason)
    {
        try
        {
            if (File.Exists(FilePath)) File.Delete(FilePath);
            _log?.Invoke($"Credentials deleted — {reason}");
            return true;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"❌ Could not delete the credentials ({reason}): {ex.Message}");
            return false;
        }
    }

    private void Quarantine(string reason)
    {
        try
        {
            var target = Path.Combine(DirectoryPath, QuarantineFileName);
            File.Move(FilePath, target, overwrite: true);
            _log?.Invoke($"⚠️ Credentials moved aside ({QuarantineFileName}) — {reason}");
        }
        catch (Exception ex)
        {
            _log?.Invoke($"⚠️ Could not move the credentials aside: {ex.Message}");
        }
    }

    // ── JSON ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Hand-written JSON, not reflection-based <c>JsonSerializer.Serialize&lt;T&gt;</c>. Two
    /// reasons: (a) which fields go to disk can be seen at a glance, so there is no chance of a
    /// secret slipping in by mistake; (b) if trimming is enabled in future, reflection would break
    /// silently.
    /// </summary>
    private static byte[] Serialize(DeviceCredentialRecord record)
    {
        using var buffer = new MemoryStream(512);

        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", SchemaVersion);
            writer.WriteNumber("deviceId", record.DeviceId);
            writer.WriteString("deviceToken", record.Token.Reveal());
            writer.WriteString("machineGuid", record.MachineGuid);
            writer.WriteString("hostname", record.Hostname);
            writer.WriteString("enrolledAt", record.EnrolledAt.ToString("O"));
            writer.WriteNumber("employeeId", record.Employee.Id);
            writer.WriteString("empCode", record.Employee.EmpCode);
            writer.WriteString("fullName", record.Employee.FullName);

            if (record.AgentVersion is { } version)
                writer.WriteString("agentVersion", version);

            writer.WriteEndObject();
            writer.Flush();
        }

        var length = (int)buffer.Length;
        var exact = new byte[length];
        Buffer.BlockCopy(buffer.GetBuffer(), 0, exact, 0, length);

        // the MemoryStream's internal buffer also held the token: that is wiped too.
        CryptographicOperations.ZeroMemory(buffer.GetBuffer());

        return exact;
    }

    private static DeviceCredentialRecord? Parse(byte[] utf8Json, out string? error)
    {
        try
        {
            using var document = JsonDocument.Parse(utf8Json);
            var root = document.RootElement;

            var version = root.TryGetProperty("v", out var v) ? v.GetInt32() : 0;
            if (version != SchemaVersion)
            {
                error = $"unknown schema version {version} (expected {SchemaVersion})";
                return null;
            }

            var token = root.GetProperty("deviceToken").GetString();
            if (string.IsNullOrWhiteSpace(token))
            {
                error = "deviceToken is empty";
                return null;
            }

            error = null;
            return new DeviceCredentialRecord
            {
                DeviceId = root.GetProperty("deviceId").GetInt32(),
                Token = new SecretText(token),
                MachineGuid = root.GetProperty("machineGuid").GetString() ?? string.Empty,
                Hostname = root.GetProperty("hostname").GetString() ?? string.Empty,
                EnrolledAt = DateTimeOffset.TryParse(
                    root.GetProperty("enrolledAt").GetString(),
                    null,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out var enrolledAt)
                    ? enrolledAt
                    : DateTimeOffset.MinValue,
                Employee = new EnrolledEmployee(
                    root.TryGetProperty("employeeId", out var eid) ? eid.GetInt32() : 0,
                    root.TryGetProperty("empCode", out var code) ? code.GetString() ?? "?" : "?",
                    root.TryGetProperty("fullName", out var name) ? name.GetString() ?? "?" : "?"),
                AgentVersion = root.TryGetProperty("agentVersion", out var av) ? av.GetString() : null,
            };
        }
        catch (Exception ex)
        {
            // Careful: a JsonException's message sometimes contains the surrounding raw text, and
            // that text may contain the token. So ex.Message is not used.
            error = "could not read the credentials file (" + ex.GetType().Name + ")";
            return null;
        }
    }
}
