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

        var security = new DirectorySecurity();

        // Inheritance off. ProgramData's default gives Authenticated Users create/write rights; if
        // that were pulled in, any user could place or change files here.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        const InheritanceFlags Inherit =
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));

        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));

        // Users = Modify, not FullControl.
        // Careful: FullControl includes DeleteSubdirectoriesAndFiles, and then an ordinary user
        // could delete device.dat (even though they have only Read on the file) and stop the agent.
        // With Modify they can write their own agent's outbox, but cannot delete files placed by
        // someone else.
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            FileSystemRights.Modify, Inherit, PropagationFlags.None, AccessControlType.Allow));

        new DirectoryInfo(path).Create(security);
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
