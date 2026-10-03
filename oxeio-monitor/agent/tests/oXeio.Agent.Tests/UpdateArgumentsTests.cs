namespace oXeio.Agent.Tests;

/// <summary>
/// The update's msiexec line carries the PC's update key forward — otherwise
/// the first update would rewrite the registry without it and turn the
/// signature check off.
/// </summary>
public class UpdateArgumentsTests
{
    [Fact]
    public void Without_a_key_the_line_is_as_before() =>
        Assert.Equal("/i \"C:\\u\\a.msi\" /qb", AgentHost.MsiArguments(@"C:\u\a.msi", null));

    [Fact]
    public void A_key_is_passed_on_as_one_line() =>
        Assert.Equal(
            "/i \"a.msi\" /qb UPDATEKEY=\"MFkwEwYH\"",
            AgentHost.MsiArguments("a.msi", "-----BEGIN PUBLIC KEY-----\nMFkw\nEwYH\n-----END PUBLIC KEY-----\n"));

    [Fact]
    public void A_key_with_a_quote_is_not_put_on_a_command_line() =>
        Assert.Equal("/i \"a.msi\" /qb", AgentHost.MsiArguments("a.msi", "abc\"def"));
}
