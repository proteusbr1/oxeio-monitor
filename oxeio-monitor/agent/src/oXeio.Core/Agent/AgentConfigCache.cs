using System.Text.Json;

namespace oXeio.Core.Agent;

/// <summary>
/// The last good config from the server, as kept on disk.
///
/// ⚠️ Without it the agent starts every boot on <see cref="AgentConfig.Default"/>
/// (UTC zone, 60 s idle, 07:00–23:00) and keeps it until the server answers. A PC
/// rebooted while the server is unreachable would then count with a policy
/// nobody chose, and nothing on the dashboard would say so.
///
/// <see cref="Version"/> travels with the config: the heartbeat reports it,
/// so when it still matches the server's no new fetch is needed, and when it
/// does not the server's answer replaces the cache as usual.
/// </summary>
public sealed record CachedAgentConfig
{
    public required string Version { get; init; }

    /// <summary>When this config came from the server — for the log, and for anyone debugging.</summary>
    public required DateTimeOffset ReceivedAt { get; init; }

    public required AgentConfig Config { get; init; }
}

/// <summary>Text ↔ <see cref="CachedAgentConfig"/> — pure, no disk.</summary>
public static class AgentConfigCacheCodec
{
    // camelCase like the wire, so the file reads like the server's answer
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public static string Serialize(CachedAgentConfig cached) =>
        JsonSerializer.Serialize(cached, Json);

    /// <summary>
    /// <c>null</c> for anything unusable — unreadable JSON, a missing field, an
    /// empty version, or a config <see cref="AgentConfigCheck"/> refuses. The
    /// caller then starts on <see cref="AgentConfig.Default"/>, as before.
    /// </summary>
    public static CachedAgentConfig? TryDeserialize(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        try
        {
            var cached = JsonSerializer.Deserialize<CachedAgentConfig>(text, Json);
            if (cached is null || string.IsNullOrWhiteSpace(cached.Version)) return null;

            return AgentConfigCheck.IsUsable(cached.Config) ? cached : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
