namespace oXeio.Core.Agent;

/// <summary>
/// What the server can ask the agent to do in reply to a heartbeat.
///
/// Careful: this is not a button for staff. Commands only come from the admin dashboard.
/// </summary>
public enum AgentCommand
{
    /// <summary>Config version mismatch: fetch it again with <c>GET /agent/config</c>.</summary>
    ReloadConfig,

    /// <summary>Take a picture right now without waiting for the slot (only if inside the capture window).</summary>
    CaptureNow,

    /// <summary>Pause tracking temporarily. Careful: the queue does not stop; stored data keeps uploading.</summary>
    PauseTracking,

    /// <summary>See <c>GET /agent/update</c>.</summary>
    UpdateAgent,

    /// <summary>
    /// This device is revoked. Tracking stops permanently and the tray says so.
    /// The same signal can also arrive in a 403 body, see <see cref="SyncOutcome.Revoked"/>.
    /// </summary>
    Revoke,
}

/// <summary>
/// Goes over the wire as a snake_case string. If five modules each wrote their own
/// <c>switch</c>, one would have a typo and silently drop that command, so the mapping
/// lives in one place.
/// </summary>
public static class AgentCommands
{
    public const string ReloadConfig = "reload_config";
    public const string CaptureNow = "capture_now";
    public const string PauseTracking = "pause_tracking";
    public const string UpdateAgent = "update_agent";
    public const string Revoke = "revoke";

    /// <summary>Null for an unknown command, so the agent does not break when a future server sends a new one.</summary>
    public static AgentCommand? Parse(string? wire) => wire switch
    {
        ReloadConfig => AgentCommand.ReloadConfig,
        CaptureNow => AgentCommand.CaptureNow,
        PauseTracking => AgentCommand.PauseTracking,
        UpdateAgent => AgentCommand.UpdateAgent,
        Revoke => AgentCommand.Revoke,
        _ => null,
    };

    public static string ToWire(AgentCommand command) => command switch
    {
        AgentCommand.ReloadConfig => ReloadConfig,
        AgentCommand.CaptureNow => CaptureNow,
        AgentCommand.PauseTracking => PauseTracking,
        AgentCommand.UpdateAgent => UpdateAgent,
        AgentCommand.Revoke => Revoke,
        _ => command.ToString(),
    };
}
