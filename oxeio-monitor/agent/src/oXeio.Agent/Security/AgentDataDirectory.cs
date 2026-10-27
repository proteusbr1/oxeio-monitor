using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

using oXeio.Agent.Storage;

namespace oXeio.Agent.Security;

/// <summary>
/// The home of all the agent's persistent files: <c>%ProgramData%\oXeio</c>: token, outbox,
/// accumulated .webp files, logs.
///
/// Careful: the folder is created from <b>one place only</b>. Previously
/// <see cref="MachineIdentity"/> and <see cref="DeviceTokenStore"/> each created it their own way,
/// and that hid a silent bug: whichever ran first would create the folder with
/// <c>Directory.CreateDirectory</c> and ProgramData's <b>loose inherited ACL</b>, then the second
/// saw "the folder already exists" and never applied the ACL, so the strict permissions were never
/// applied at all, although reading the code made it look as if they were.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class AgentDataDirectory
{
    /// <summary>
    /// <c>%ProgramData%\oXeio</c>. The folder name is taken from
    /// <see cref="OutboxPaths.AppFolderName"/>: if two modules assumed two different names, the
    /// token would sit in one folder and the outbox in another.
    ///
    /// Careful: this is deliberately <b>not</b> the <c>Root</c> of
    /// <see cref="OutboxPaths.Default"/>. That one falls back to %LOCALAPPDATA% when ProgramData
    /// cannot be written: fine for the queue ("better than counting nothing"), but fatal for the
    /// token: if the token went to the user profile, on logging in to another account the agent
    /// would not find its token, yet would not enroll again either, since it is enrolled. A
    /// machine-wide secret stays in a machine-wide place, or nowhere.
    /// </summary>
    public static string Default { get; } = Path.Combine(
        Environment.GetFolderPath(
            Environment.SpecialFolder.CommonApplicationData,
            Environment.SpecialFolderOption.DoNotVerify),
        OutboxPaths.AppFolderName);

    /// <summary>
    /// Creates it with a strict ACL if absent; if present, <b>touches nothing</b>.
    ///
    /// Careful: an existing folder's ACL is not forced. The installer or an admin may have changed
    /// permissions on purpose (for example adding a service account); erasing that on every startup
    /// would suddenly stop the outbox from writing and nobody would find the reason.
    ///
    /// Careful: <b>there is a race here, and it is accepted:</b>
    /// <see cref="OutboxPaths.Resolve"/> can also create the same folder with
    /// <c>Directory.CreateDirectory</c>, and if it runs first the folder will be created with
    /// ProgramData's loose inherited ACL, and this method will then do nothing. The token's
    /// security still holds, because <c>device.dat</c> has its own ACL that is protected
    /// (inheritance off) and is set explicitly on every write. The folder's ACL only decides "who
    /// can create/delete files here", not "who can read the token". To make it stricter, let the
    /// installer create the folder first and set the ACL.
    /// </summary>
    public static void Ensure(string path)
    {
        if (Directory.Exists(path)) return;

        new DirectoryInfo(path).Create(StrictSecurity());
    }

    private static readonly SecurityIdentifier LocalSystem =
        new(WellKnownSidType.LocalSystemSid, null);

    private static readonly SecurityIdentifier Administrators =
        new(WellKnownSidType.BuiltinAdministratorsSid, null);

    private static readonly SecurityIdentifier Users =
        new(WellKnownSidType.BuiltinUsersSid, null);

    private static readonly SecurityIdentifier CreatorOwner =
        new(WellKnownSidType.CreatorOwnerSid, null);

    /// <summary>NT SERVICE\TrustedInstaller: owns much of Windows; never a standard user.</summary>
    private static readonly SecurityIdentifier TrustedInstaller =
        new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

    /// <summary>
    /// The one definition of the folder's ACL (also <see cref="Harden"/>'s reset target).
    ///
    /// Careful: <b>Users get Modify on what is inside, but not <c>DELETE</c> on the folder
    /// itself.</b> Modify includes <c>DELETE</c>, and with it on the root any user could rename
    /// <c>%ProgramData%\oXeio</c> away (ProgramData lets Users create folders) and put a junction
    /// in its place pointing anywhere; the next thing that writes "into the data folder" as SYSTEM
    /// (the installer's <c>--prepare-data-dir</c>) would then write there. So the rule is split in
    /// two: Modify minus Delete for this folder, full Modify inherited by everything below.
    /// </summary>
    internal static DirectorySecurity StrictSecurity()
    {
        var security = new DirectorySecurity();

        // Inheritance off. ProgramData's default gives Authenticated Users create/write rights; if
        // that were pulled in, any user could place or change files here.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        const InheritanceFlags Inherit =
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

        security.AddAccessRule(new FileSystemAccessRule(
            LocalSystem, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));

        security.AddAccessRule(new FileSystemAccessRule(
            Administrators, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));

        // Users = Modify, not FullControl.
        // Careful: FullControl includes DeleteSubdirectoriesAndFiles, and then an ordinary user
        // could delete device.dat (even though they have only Read on the file) and stop the agent.
        // With Modify they can write their own agent's outbox, but cannot delete files placed by
        // someone else.
        security.AddAccessRule(new FileSystemAccessRule(
            Users, FileSystemRights.Modify & ~FileSystemRights.Delete,
            InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));

        security.AddAccessRule(new FileSystemAccessRule(
            Users, FileSystemRights.Modify, Inherit, PropagationFlags.InheritOnly, AccessControlType.Allow));

        return security;
    }

    /// <summary>
    /// <b>M3: run as SYSTEM by the installer</b> (<c>--prepare-data-dir</c>). Like
    /// <see cref="Ensure"/>, but an <b>existing</b> folder is not simply trusted.
    ///
    /// The attack: <see cref="Ensure"/> leaves an existing folder as it is. A standard user can
    /// create <c>%ProgramData%\oXeio</c> <b>before</b> the agent is installed (ProgramData allows
    /// that), and is then its owner, with whatever ACL they like, or makes it a junction to
    /// somewhere else. Every later "strict ACL" decision silently never happens.
    ///
    /// So, as SYSTEM:
    /// <list type="number">
    /// <item>if the folder itself is a junction or symlink, the <b>link</b> is removed (not its
    /// target) and a fresh folder is created;</item>
    /// <item>any junction or symlink <b>inside</b> it is removed (the agent never makes one, and
    /// one there could send a SYSTEM write, or the ACL propagation below, elsewhere);</item>
    /// <item>if the owner is not SYSTEM / Administrators / TrustedInstaller, or the ACL is not
    /// protected, or grants a non-admin more than <see cref="StrictSecurity"/> does (see
    /// <see cref="IsExpected"/>), owner and ACL are reset to the strict ones.</item>
    /// </list>
    ///
    /// Careful: <b>only at install time, never on every startup.</b> The agent itself runs as the
    /// staff member and could not change the owner anyway, and the "do not force an existing
    /// ACL" rule of <see cref="Ensure"/> still holds for an ACL that is merely different but not
    /// dangerous (an admin who added a service account with Modify on the contents keeps it).
    ///
    /// Careful: files and folders <b>below</b> keep their owners; a pre-created folder may
    /// still hold files its creator owns (and can re-ACL). The token file sets its own ACL on
    /// every write; the rest is not secret. Per-user data separation is a separate, larger topic.
    /// </summary>
    public static void Harden(string path, Action<string> report)
    {
        var info = new DirectoryInfo(path);

        if (info.Exists && info.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            report($"⚠️ {path} was a junction/link (to {info.LinkTarget ?? "?"}) — removed the link");

            // Careful: non-recursive. For a junction or directory symlink this removes the link
            // itself; the folder it points to is not touched.
            Directory.Delete(path, recursive: false);
        }
        else if (File.Exists(path))
        {
            report($"⚠️ {path} was a file — removed");
            File.Delete(path);
        }

        if (!Directory.Exists(path))
        {
            Ensure(path);
            return;
        }

        RemoveLinksInside(path, report);

        var current = new DirectoryInfo(path).GetAccessControl(
            AccessControlSections.Owner | AccessControlSections.Access);

        if (IsExpected(current, out var why)) return;

        report($"⚠️ {path}: {why} — owner and permissions reset");

        var strict = StrictSecurity();
        strict.SetOwner(Administrators);
        new DirectoryInfo(path).SetAccessControl(strict);
    }

    private static void RemoveLinksInside(string path, Action<string> report)
    {
        // Careful: .NET's recursive enumeration does not descend into reparse points, so this
        // never walks out of the folder through the very links it is looking for.
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            AttributesToSkip = 0,
            IgnoreInaccessible = true,
        };

        foreach (var entry in new DirectoryInfo(path).EnumerateFileSystemInfos("*", options).ToList())
        {
            if (!entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;

            report($"⚠️ {entry.FullName} was a junction/link — removed the link");
            if (entry is DirectoryInfo) Directory.Delete(entry.FullName, recursive: false);
            else File.Delete(entry.FullName);
        }
    }

    /// <summary>
    /// Is this ACL one that a standard user cannot have shaped? <c>false</c> with the reason when:
    /// the owner is not SYSTEM / Administrators / TrustedInstaller; inheritance is on (then
    /// ProgramData's loose rules apply); or anyone but those three is granted something
    /// <see cref="StrictSecurity"/> does not give Users: taking ownership, changing permissions,
    /// deleting other people's files (<c>DeleteSubdirectoriesAndFiles</c>), generic all, or
    /// <c>DELETE</c> on the folder itself.
    /// </summary>
    internal static bool IsExpected(DirectorySecurity security, out string why)
    {
        var owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner is null || !IsAdminLike(owner))
        {
            why = $"owned by {owner?.Value ?? "nobody"}";
            return false;
        }

        if (!security.AreAccessRulesProtected)
        {
            why = "it inherits ProgramData's permissions";
            return false;
        }

        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            if (rule.IdentityReference is not SecurityIdentifier sid || IsAdminLike(sid)) continue;

            if (GrantsTooMuch(sid, rule.FileSystemRights, rule.PropagationFlags))
            {
                why = $"{sid.Value} is granted {rule.FileSystemRights}";
                return false;
            }
        }

        why = "";
        return true;
    }

    private static bool IsAdminLike(SecurityIdentifier sid) =>
        sid == LocalSystem || sid == Administrators || sid == TrustedInstaller;

    /// <summary>
    /// Rights a non-admin must not have here. Raw ACE masks are compared, so generic rights
    /// (<c>GENERIC_ALL</c> = 0x10000000, which shows up undecoded) count too.
    /// </summary>
    internal static bool GrantsTooMuch(SecurityIdentifier sid, FileSystemRights rights, PropagationFlags propagation)
    {
        const int GenericAll = 0x10000000;
        var mask = (int)rights;

        // CREATOR OWNER only ever applies to what someone creates themselves
        if (sid == CreatorOwner) return false;

        var dangerous = FileSystemRights.ChangePermissions
                        | FileSystemRights.TakeOwnership
                        | FileSystemRights.DeleteSubdirectoriesAndFiles;

        if ((mask & GenericAll) != 0 || (rights & dangerous) != 0) return true;

        // DELETE on the folder itself (a rule that is not inherit-only applies to it)
        return !propagation.HasFlag(PropagationFlags.InheritOnly) && (rights & FileSystemRights.Delete) != 0;
    }

    /// <summary>On failure no throw: the reason is returned. For use on the startup path.</summary>
    public static bool TryEnsure(string path, out string? error)
    {
        try
        {
            Ensure(path);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name + ": " + ex.Message;
            return false;
        }
    }
}
