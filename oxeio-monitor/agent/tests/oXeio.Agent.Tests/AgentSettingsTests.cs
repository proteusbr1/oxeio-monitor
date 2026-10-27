namespace oXeio.Agent.Tests;

/// <summary>
/// H2 / L1: where the agent's settings come from, and which of them a standard user can
/// influence. The environment variable and agent.json are both writable by the person being
/// monitored; HKLM is not.
/// </summary>
public class AgentSettingsTests
{
    private const string Pin = "pin-from-hklm";
    private const string Key = "key-from-hklm";

    private static readonly AgentSettings.MachineConfig Installed = new()
    {
        ServerUrl = "https://monitor.example.com",
        ServerPin = Pin,
        UpdatePublicKey = Key,
    };

    private static (AgentSettings?, string) NoFile() => (null, @"C:\ProgramData\oXeio\agent.json");

    private static Func<(AgentSettings?, string)> File(string url) =>
        () => (new AgentSettings { ServerUrl = url, UpdatePublicKey = "key-from-file" }, "agent.json");

    private static AgentSettings? Resolve(
        string? env, AgentSettings.MachineConfig machine, bool debug = false,
        Func<(AgentSettings?, string)>? file = null) =>
        AgentSettings.Resolve(env, machine, file ?? NoFile, debug, out _);

    // ── H2: the environment variable ───────────────────────────────────────

    [Fact]
    public void In_a_release_build_the_environment_variable_is_ignored()
    {
        var s = Resolve("https://attacker.example", Installed);

        Assert.NotNull(s);
        Assert.Equal("https://monitor.example.com", s.ServerUrl);
        Assert.Equal(Pin, s.ServerPin);
        Assert.Equal(Key, s.UpdatePublicKey);
        Assert.Contains("ignored", s.LoadWarning);
    }

    [Fact]
    public void In_a_debug_build_it_changes_the_address_but_keeps_pin_and_update_key()
    {
        var s = Resolve("https://dev.example", Installed, debug: true);

        Assert.NotNull(s);
        Assert.Equal("https://dev.example", s.ServerUrl);
        Assert.Equal(Pin, s.ServerPin);
        Assert.Equal(Key, s.UpdatePublicKey);
    }

    [Fact]
    public void An_administrator_can_allow_it_in_HKLM_and_the_pin_and_key_still_apply()
    {
        var s = Resolve("https://other.example", Installed with { AllowServerUrlOverride = true });

        Assert.NotNull(s);
        Assert.Equal("https://other.example", s.ServerUrl);
        Assert.Equal(Pin, s.ServerPin);
        Assert.Equal(Key, s.UpdatePublicKey);
    }

    [Fact]
    public void Without_an_install_a_release_build_ignores_it_too() =>
        Assert.Null(Resolve("https://attacker.example", AgentSettings.MachineConfig.Absent));

    // ── agent.json ──────────────────────────────────────────────────────

    [Fact]
    public void Agent_json_is_used_only_when_HKLM_has_no_key_at_all()
    {
        var s = Resolve(null, AgentSettings.MachineConfig.Absent, file: File("https://manual.example"));

        Assert.Equal("https://manual.example", s?.ServerUrl);
    }

    [Fact]
    public void A_broken_HKLM_key_does_not_fall_back_to_agent_json()
    {
        var file = File("https://attacker.example");

        Assert.Null(Resolve(null, Installed with { ServerUrl = null }, file: file));
        Assert.Null(Resolve(null, Installed with { ServerUrl = "not a url" }, file: file));
        Assert.Null(Resolve(null, new AgentSettings.MachineConfig { ReadError = "denied" }, file: file));
    }

    [Fact]
    public void The_reason_is_in_the_source_when_nothing_is_usable()
    {
        AgentSettings.Resolve(null, Installed with { ServerUrl = "http://10.0.0.5:8080" }, NoFile, false, out var source);

        Assert.Contains("ALLOWHTTP", source);
    }

    // ── L1: plain http ──────────────────────────────────────────────────────

    [Theory]
    [InlineData("https://monitor.example.com", false, true)]
    [InlineData("http://monitor.example.com", false, false)]
    [InlineData("http://10.0.0.5:8080", false, false)]
    [InlineData("http://10.0.0.5:8080", true, true)]
    [InlineData("http://localhost:3000", false, true)]
    [InlineData("http://127.0.0.1:3000", false, true)]
    [InlineData("http://[::1]:3000", false, true)]
    [InlineData("ftp://monitor.example.com", true, false)]
    [InlineData("monitor.example.com", true, false)]
    public void Http_only_to_this_PC_or_when_allowed(string url, bool allowHttp, bool usable) =>
        Assert.Equal(usable, AgentSettings.IsAcceptableServerUrl(url, allowHttp));

    [Fact]
    public void The_HKLM_opt_in_allows_http_to_the_LAN_server()
    {
        var lan = Installed with { ServerUrl = "http://10.0.0.5:8080" };

        Assert.Null(Resolve(null, lan));
        Assert.NotNull(Resolve(null, lan with { AllowInsecureHttp = true }));
    }

    [Fact]
    public void Agent_json_can_never_allow_http_to_another_machine()
    {
        Assert.Null(Resolve(null, AgentSettings.MachineConfig.Absent, file: File("http://10.0.0.5:8080")));
        Assert.NotNull(Resolve(null, AgentSettings.MachineConfig.Absent, file: File("http://localhost:3000")));
    }

    [Fact]
    public void A_debug_build_accepts_http_anywhere() =>
        Assert.NotNull(Resolve("http://10.0.0.5:8080", AgentSettings.MachineConfig.Absent, debug: true));

    [Theory]
    [InlineData(1, true)]
    [InlineData(0, false)]
    [InlineData("1", true)]
    [InlineData("true", true)]
    [InlineData("", false)]
    [InlineData("0", false)]
    [InlineData(null, false)]
    public void Registry_switches(object? value, bool on) =>
        Assert.Equal(on, AgentSettings.IsOn(value));
}
