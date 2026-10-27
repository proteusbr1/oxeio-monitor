using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// The offered version is used in a file name and a URL (M2), and decides whether an offer is an
/// upgrade at all (L2). Both must be strict.
/// </summary>
public class SemVerTests
{
    [Theory]
    [InlineData("0.5.1")]
    [InlineData("10.20.30")]
    [InlineData("1.0.0-beta.2")]
    [InlineData("1.0.0-rc-1")] // the server's PublishVersionDto allows '-' in the pre-release
    public void What_the_server_publishes_is_valid(string version) =>
        Assert.True(SemVer.IsValid(version));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1.2")]
    [InlineData("v1.2.3")]
    [InlineData(" 1.2.3")]
    [InlineData("1.2.3 ")]
    [InlineData("1.2.3+abc")]
    [InlineData("1.2.3-")]
    [InlineData(@"..\..\evil")]
    [InlineData("1.2.3/../../x")]
    [InlineData(@"1.2.3-a\b")]
    [InlineData("1.2.3-a:b")]
    [InlineData("C:")]
    [InlineData("1.2.3\r\n")]
    [InlineData("1.2.3-a b")]
    [InlineData("9999999999.0.0")] // would overflow an int
    public void Anything_else_is_refused(string? version) =>
        Assert.False(SemVer.IsValid(version));

    [Fact]
    public void A_very_long_version_is_refused() =>
        Assert.False(SemVer.IsValid("1.2.3-" + new string('a', SemVer.MaxLength)));

    [Theory]
    [InlineData("0.5.2", "0.5.1")]
    [InlineData("1.10.0", "1.9.0")]   // a string comparison gets this backwards
    [InlineData("2.0.0", "1.99.99")]
    [InlineData("1.0.0", "1.0.0-beta")]
    [InlineData("1.0.0-beta.11", "1.0.0-beta.2")]
    [InlineData("1.0.0-beta", "1.0.0-alpha")]
    [InlineData("1.0.0-alpha.beta", "1.0.0-alpha.1")] // alphanumeric beats numeric
    [InlineData("1.0.0-alpha.1", "1.0.0-alpha")]
    public void Newer_is_newer(string offered, string running) =>
        Assert.True(SemVer.IsNewer(offered, running));

    [Theory]
    [InlineData("0.5.1", "0.5.1")] // the same version: a replay
    [InlineData("0.5.0", "0.5.1")] // a downgrade
    [InlineData("1.9.0", "1.10.0")]
    [InlineData("1.0.0-beta", "1.0.0")]
    [InlineData("../1.0.0", "0.0.1")]
    [InlineData(null, "0.0.1")]
    public void The_same_or_older_or_invalid_is_not_newer(string? offered, string running) =>
        Assert.False(SemVer.IsNewer(offered, running));

    /// <summary>A broken running version must not leave the PC unable to ever update.</summary>
    [Fact]
    public void An_unreadable_running_version_counts_as_zero() =>
        Assert.True(SemVer.IsNewer("0.0.1", "garbage"));
}

/// <summary>M2: the staged MSI's path is built from the offer's version; it must stay put.</summary>
public class UpdateFilesTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "oxeio-updates");

    [Fact]
    public void A_valid_version_lands_directly_in_the_updates_folder()
    {
        var path = UpdateFiles.MsiPathFor(Root, "0.5.1");

        Assert.Equal(Path.Combine(Path.GetFullPath(Root), "oXeioAgent-0.5.1.msi"), path);
    }

    [Theory]
    [InlineData(@"..\..\..\Windows\evil")]
    [InlineData("../../../tmp/evil")]
    [InlineData("/etc/evil")]
    [InlineData(@"C:\evil")]
    [InlineData("")]
    [InlineData(null)]
    public void A_version_that_would_leave_the_folder_gets_no_path(string? version) =>
        Assert.Null(UpdateFiles.MsiPathFor(Root, version));

    [Fact]
    public void Only_direct_children_count()
    {
        var root = Path.GetFullPath(Root);

        Assert.True(UpdateFiles.IsDirectChild(root, Path.Combine(root, "a.msi")));
        Assert.True(UpdateFiles.IsDirectChild(root + Path.DirectorySeparatorChar, Path.Combine(root, "a.msi")));
        Assert.False(UpdateFiles.IsDirectChild(root, Path.Combine(root, "sub", "a.msi")));
        Assert.False(UpdateFiles.IsDirectChild(root, Path.Combine(Path.GetTempPath(), "a.msi")));
        Assert.False(UpdateFiles.IsDirectChild(root, root + "-other" + Path.DirectorySeparatorChar + "a.msi"));
    }
}
