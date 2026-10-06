using System.Runtime.Versioning;

using oXeio.Core.Watchdog;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// Reads the heartbeat file. Remembers the last one that was read successfully.
///
/// <b>Why remembering matters:</b> the agent writes to a temp file and renames it, so at the
/// very moment of reading the file may be missing for an instant. Treating that instant's
/// failure as "no heartbeat" would make the watchdog kill a healthy agent, at random, once
/// every few days, so nobody could ever find the cause. Keeping the previous good value
/// still catches a real wedge within 2 minutes, because that old value goes stale by then.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class HeartbeatReader
{
    private AgentHeartbeat? _lastGood;

    public AgentHeartbeat? Read(string path)
    {
        var line = TryReadFirstLine(path);
        if (line is null) return _lastGood;

        var parsed = AgentLiveness.TryParse(line);
        if (parsed is null) return _lastGood;

        _lastGood = parsed;
        return parsed;
    }

    private static string? TryReadFirstLine(string path)
    {
        try
        {
            // FileShare must include both Write and Delete. With Read only, the agent's rename
            // (MoveFile) would fail with a sharing violation: the guard's own reading would
            // stop the agent's heartbeat, and then the guard would call it "wedged" and kill it.
            using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.SequentialScan);

            using var reader = new StreamReader(stream);
            return reader.ReadLine();
        }
        catch (Exception ex) when (
            ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }
}
