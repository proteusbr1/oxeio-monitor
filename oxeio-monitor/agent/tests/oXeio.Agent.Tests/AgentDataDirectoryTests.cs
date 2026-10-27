using System.Security.AccessControl;
using System.Security.Principal;

using oXeio.Agent.Security;

namespace oXeio.Agent.Tests;

/// <summary>
/// M3: which existing data folder the installer (as SYSTEM) accepts as it is, and which it takes
/// back. Built in memory: setting a real folder's owner needs administrator rights.
/// </summary>
public class AgentDataDirectoryTests
{
    private static readonly SecurityIdentifier Admins = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier Users = new(WellKnownSidType.BuiltinUsersSid, null);
    private static readonly SecurityIdentifier Everyone = new(WellKnownSidType.WorldSid, null);
    private static readonly SecurityIdentifier SomeUser = new("S-1-5-21-1-2-3-1001");

    private const InheritanceFlags Inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

    private static DirectorySecurity Strict(SecurityIdentifier owner)
    {
        var s = AgentDataDirectory.StrictSecurity();
        s.SetOwner(owner);
        return s;
    }

    [Fact]
    public void The_strict_ACL_owned_by_Administrators_is_left_alone() =>
        Assert.True(AgentDataDirectory.IsExpected(Strict(Admins), out _));

    [Fact]
    public void A_folder_a_standard_user_owns_is_taken_back()
    {
        Assert.False(AgentDataDirectory.IsExpected(Strict(SomeUser), out var why));
        Assert.Contains("owned by", why);
    }

    [Fact]
    public void A_folder_that_inherits_ProgramData_is_taken_back()
    {
        var s = Strict(Admins);
        s.SetAccessRuleProtection(isProtected: false, preserveInheritance: true);

        Assert.False(AgentDataDirectory.IsExpected(s, out _));
    }

    [Fact]
    public void Full_control_for_everyone_is_taken_back()
    {
        var s = Strict(Admins);
        s.AddAccessRule(new FileSystemAccessRule(
            Everyone, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));

        Assert.False(AgentDataDirectory.IsExpected(s, out _));
    }

    /// <summary>
    /// The folder as earlier versions created it: Users = Modify on the folder itself too, so a
    /// user could rename it away and leave a junction. Upgrading resets it to the split rule.
    /// </summary>
    [Fact]
    public void The_old_ACL_with_delete_on_the_folder_itself_is_upgraded()
    {
        var s = new DirectorySecurity();
        s.SetOwner(Admins);
        s.SetAccessRuleProtection(true, false);
        s.AddAccessRule(new FileSystemAccessRule(
            Admins, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));
        s.AddAccessRule(new FileSystemAccessRule(
            Users, FileSystemRights.Modify, Inherit, PropagationFlags.None, AccessControlType.Allow));

        Assert.False(AgentDataDirectory.IsExpected(s, out _));
    }

    /// <summary>An admin's own addition that is not dangerous survives, as Ensure promised.</summary>
    [Fact]
    public void A_service_account_with_modify_on_the_contents_is_kept()
    {
        var s = Strict(Admins);
        s.AddAccessRule(new FileSystemAccessRule(
            SomeUser, FileSystemRights.Modify, Inherit, PropagationFlags.InheritOnly, AccessControlType.Allow));

        Assert.True(AgentDataDirectory.IsExpected(s, out _));
    }

    [Theory]
    [InlineData(FileSystemRights.Modify, PropagationFlags.InheritOnly, false)]
    [InlineData(FileSystemRights.Modify & ~FileSystemRights.Delete, PropagationFlags.None, false)]
    [InlineData(FileSystemRights.Modify, PropagationFlags.None, true)]              // DELETE on the folder
    [InlineData(FileSystemRights.ChangePermissions, PropagationFlags.InheritOnly, true)]
    [InlineData(FileSystemRights.TakeOwnership, PropagationFlags.InheritOnly, true)]
    [InlineData(FileSystemRights.DeleteSubdirectoriesAndFiles, PropagationFlags.InheritOnly, true)]
    [InlineData((FileSystemRights)0x10000000, PropagationFlags.InheritOnly, true)] // GENERIC_ALL
    public void What_a_non_admin_may_be_granted(FileSystemRights rights, PropagationFlags propagation, bool tooMuch) =>
        Assert.Equal(tooMuch, AgentDataDirectory.GrantsTooMuch(SomeUser, rights, propagation));
}
