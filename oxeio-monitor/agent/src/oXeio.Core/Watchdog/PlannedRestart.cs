using System.Globalization;
using System.Text;

namespace oXeio.Core.Watchdog;

/// <summary>
/// "I am leaving on purpose, start me again": what the agent leaves for the watchdog just before a
/// planned exit (today only the resource ceiling, <see cref="ResourceCeiling"/>).
///
/// <b>Why a separate signal is needed at all.</b> Without it the watchdog sees a planned exit
/// exactly like a crash: the lock is free, so <see cref="WatchdogReason.AgentMissing"/>, and the
/// launch climbs the <see cref="RestartLadder"/>. Usually harmless (an agent that ran for hours has
/// a reset ladder), but a crash shortly after a planned restart would then wait a step longer than
/// it should, and the log would read "agent missing" for something the agent chose to do.
///
/// <b>Why not the existing files:</b>
/// <list type="bullet">
/// <item><c>watchdog.stop</c> means the opposite ("stop watching"): the uninstaller's switch.</item>
/// <item><c>agent.alive</c> is deleted on every clean exit (<c>LivenessBeacon.Dispose</c>), so a
/// field in it would vanish at exactly the moment it is needed.</item>
/// </list>
/// So: its own one-line file, <c>agent.restart</c>, in the same key=value format as
/// <c>agent.alive</c>, stamped on the same unbiased clock so the watchdog can tell a fresh request
/// from one left over from an earlier boot.
/// </summary>
public sealed record PlannedRestart
{
    public required int ProcessId { get; init; }

    /// <summary><c>QueryUnbiasedInterruptTime</c> in ms when written: see <see cref="AgentHeartbeat.UnbiasedMs"/>.</summary>
    public required long UnbiasedMs { get; init; }

    /// <summary>A short token for the log, e.g. <c>resource_ceiling</c>. No spaces.</summary>
    public required string Reason { get; init; }

    /// <summary>For people only, like <see cref="AgentHeartbeat.WrittenAtUtc"/>.</summary>
    public DateTimeOffset WrittenAtUtc { get; init; }

    /// <summary>What the agent held when it decided, for the watchdog's log.</summary>
    public long? HandleCount { get; init; }

    public long? PrivateBytes { get; init; }
}

/// <summary>Names, freshness and the one-line format of the planned-restart files.</summary>
public static class PlannedRestartFiles
{
    /// <summary>Written by the agent just before a planned exit; consumed (deleted) by the watchdog.</summary>
    public const string MarkerFileName = "agent.restart";

    /// <summary>
    /// When the last <b>ceiling</b> restart was requested: the agent's own loop guard
    /// (<see cref="ResourceCeiling.MinGapBetweenRestarts"/>). Separate from the marker on purpose:
    /// the watchdog deletes the marker, and this must survive into the next process.
    /// </summary>
    public const string CeilingStampFileName = "agent.ceiling";

    /// <summary>
    /// A marker older than this is ignored. The graceful exit takes at most ~4 s
    /// (<c>Program.ShutdownBudget</c>) and the watchdog looks every 30 s, so a real request is
    /// seen well within a minute. Five minutes leaves room for a slow disk, yet a marker left by
    /// an exit that never happened cannot excuse a crash much later.
    /// </summary>
    public static TimeSpan MaxAge => TimeSpan.FromMinutes(5);

    public static string Format(PlannedRestart restart)
    {
        ArgumentNullException.ThrowIfNull(restart);

        var line = new StringBuilder();
        line.Append(CultureInfo.InvariantCulture,
            $"v=1 pid={restart.ProcessId} unbiased={restart.UnbiasedMs} reason={Token(restart.Reason)}");

        if (restart.HandleCount is { } h) line.Append(CultureInfo.InvariantCulture, $" handles={h}");
        if (restart.PrivateBytes is { } p) line.Append(CultureInfo.InvariantCulture, $" private={p}");

        line.Append(CultureInfo.InvariantCulture, $" utc={restart.WrittenAtUtc.UtcDateTime:O}");
        return line.ToString();
    }

    /// <summary>
    /// <c>null</c> for a broken line. Unknown keys are ignored, for the same reason as in
    /// <see cref="AgentLiveness.TryParse"/>: the agent and the watchdog are not always updated in
    /// the same instant.
    /// </summary>
    public static PlannedRestart? TryParse(string? line)
    {
        var fields = KeyValueLine.Parse(line);
        if (fields is null) return null;

        if (!KeyValueLine.TryInt(fields, "pid", out var pid) || pid <= 0) return null;
        if (!KeyValueLine.TryLong(fields, "unbiased", out var unbiased) || unbiased < 0) return null;

        return new PlannedRestart
        {
            ProcessId = pid,
            UnbiasedMs = unbiased,
            Reason = fields.TryGetValue("reason", out var reason) ? reason : "unknown",
            HandleCount = KeyValueLine.TryLong(fields, "handles", out var h) ? h : null,
            PrivateBytes = KeyValueLine.TryLong(fields, "private", out var p) ? p : null,
            WrittenAtUtc = fields.TryGetValue("utc", out var utc)
                           && DateTimeOffset.TryParse(
                               utc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var t)
                ? t
                : DateTimeOffset.MinValue,
        };
    }

    /// <summary>
    /// Is the request recent enough to act on? Careful: a marker "from the future" is from an
    /// earlier boot (see <see cref="AgentLiveness.Age"/>), so it is <b>not</b> fresh.
    /// </summary>
    public static bool IsFresh(long markerUnbiasedMs, long nowUnbiasedMs) =>
        nowUnbiasedMs >= markerUnbiasedMs
        && nowUnbiasedMs - markerUnbiasedMs <= (long)MaxAge.TotalMilliseconds;

    /// <summary>The ceiling stamp: one round-trip UTC instant.</summary>
    public static string FormatStamp(DateTimeOffset utc) =>
        utc.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);

    /// <summary><c>null</c> if missing or unreadable: then there is no recent restart to respect.</summary>
    public static DateTimeOffset? TryParseStamp(string? text) =>
        !string.IsNullOrWhiteSpace(text)
        && DateTimeOffset.TryParse(
            text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var t)
            ? t
            : null;

    /// <summary>Keeps the reason one token: a space would split the key=value line.</summary>
    private static string Token(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason)) return "unknown";

        var chars = reason.Trim().Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '_');
        var token = new string(chars.ToArray());
        return token.Length > 64 ? token[..64] : token;
    }
}

/// <summary><c>key=value key=value</c>: the shape both watchdog files share.</summary>
internal static class KeyValueLine
{
    public static Dictionary<string, string>? Parse(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;

        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var token in line.Split(
                     ' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = token.IndexOf('=');
            if (eq <= 0 || eq == token.Length - 1) continue;
            fields[token[..eq]] = token[(eq + 1)..];
        }

        return fields;
    }

    public static bool TryInt(Dictionary<string, string> fields, string key, out int value)
    {
        value = 0;
        return fields.TryGetValue(key, out var raw)
               && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }

    public static bool TryLong(Dictionary<string, string> fields, string key, out long value)
    {
        value = 0;
        return fields.TryGetValue(key, out var raw)
               && long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }
}
