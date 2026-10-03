using System.Text.Json;

using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary><c>screenshot.enabled</c> on the wire — on unless the server says off.</summary>
public class AgentConfigScreenshotTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static ScreenshotConfig Parse(string json) =>
        JsonSerializer.Deserialize<ScreenshotConfig>(json, Web)!;

    [Fact]
    public void Default_config_takes_screenshots() =>
        Assert.True(AgentConfig.Default.Screenshot.IsEnabled);

    [Fact]
    public void An_older_server_without_the_field_means_on() =>
        Assert.True(Parse("""{"format":"webp","quality":70,"maxWidth":1920,"allMonitors":true}""").IsEnabled);

    [Fact]
    public void Enabled_false_turns_them_off() =>
        Assert.False(Parse("""{"enabled":false,"format":"webp","quality":70,"maxWidth":1920,"allMonitors":true}""").IsEnabled);
}
