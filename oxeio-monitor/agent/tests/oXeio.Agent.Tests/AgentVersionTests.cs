namespace oXeio.Agent.Tests;

/// <summary>
/// What version the agent reports to the server.
///
/// Careful: this number is not harmless. The server decides from the heartbeat's version
/// whether to offer an update (G59). If it is wrong or stale, a machine that has already
/// updated keeps being offered the same update, and the staged rollout (H04) never finishes.
/// </summary>
public class AgentVersionTests
{
    /// <summary>
    /// Measured, not imagined: the <c>ProductVersion</c> of a built DLL really does
    /// come out as <c>0.1.0+&lt;commit&gt;</c>.
    /// </summary>
    [Fact]
    public void commit_hash_ছেঁটে_ফেলা_হয়() =>
        Assert.Equal(
            "0.1.0",
            Program.TrimBuildMetadata("0.1.0+ef685e42b94046aa7b4f05b6ccc1a34990357d89"));

    [Fact]
    public void সাধারণ_ভার্সন_অক্ষত_থাকে() =>
        Assert.Equal("0.2.3", Program.TrimBuildMetadata("0.2.3"));

    /// <summary>A pre-release part stays: it belongs to SemVer, it is not build metadata.</summary>
    [Fact]
    public void pre_release_অংশ_থেকে_যায়() =>
        Assert.Equal("1.0.0-beta.2", Program.TrimBuildMetadata("1.0.0-beta.2+abc123"));

    /// <summary>
    /// When empty the result is <c>"0.0.0"</c>, not an empty string. If an empty string
    /// were sent, the server would read it as "no version reported" and keep the old one
    /// (G59), hiding the problem even deeper.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("+onlymetadata")]
    public void কিছু_না_পেলে_শূন্য_ভার্সন(string? raw) =>
        Assert.Equal("0.0.0", Program.TrimBuildMetadata(raw));
}
