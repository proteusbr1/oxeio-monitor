using System.Globalization;

namespace oXeio.Core.Watchdog;

/// <summary>
/// The one line the agent writes regularly, and which the watchdog reads.
///
/// <b>Why a file, not a mutex:</b> a mutex only says "a process exists". But a wedged process
/// is perfectly alive and holds its mutex too, so the very failure the watchdog is written
/// to catch is exactly what a mutex cannot catch. A file with a timestamp proves the agent's
/// loop is <b>turning</b>, not merely alive.
///
/// The agent keeps writing this file while IDLE or LOCKED too. Liveness means whether the
/// agent's loop is running; whether the user is working is an entirely separate question.
/// Mix them up and the agent would be killed every day at lunchtime.
/// </summary>
public sealed record AgentHeartbeat
{
    /// <summary>Format version: so an old watchdog does not misread a new agent.</summary>
    public required int Version { get; init; }

    /// <summary>Needed to kill a wedged agent.</summary>
    public required int ProcessId { get; init; }

    /// <summary>Which Windows session it runs in: for the log only.</summary>
    public required uint SessionId { get; init; }

    /// <summary>
    /// <c>QueryUnbiasedInterruptTime</c> in milliseconds, at the moment of writing.
    ///
    /// Deliberately not the wall clock. If someone set the PC's clock back an hour, every
    /// heartbeat would look an hour stale and the watchdog would kill a healthy agent.
    ///
    /// Not <c>GetTickCount64</c> either: it counts sleep time, so a laptop that slept
    /// overnight would show an 8-hour-stale heartbeat on waking, and the agent would be killed
    /// the moment it woke. The unbiased clock stands still during sleep, so after sleep the age
    /// is what it was.
    ///
    /// Both processes read the same counter on the same machine, so the subtraction is
    /// meaningful. On boot the counter starts from zero; that is why the previous boot's file
    /// looks like it is "in the future", and <see cref="AgentLiveness.Age"/> returns <c>null</c>
    /// for it instead of treating it as fresh.
    /// </summary>
    public required long UnbiasedMs { get; init; }

    /// <summary>
    /// For people to read. It is <b>never</b> used to decide freshness: it is the wall clock,
    /// and the wall clock can go backwards.
    /// </summary>
    public required DateTimeOffset WrittenAtUtc { get; init; }
}

/// <summary>
/// The contract between the agent and the watchdog: file names, time limits, and the
/// one-line format. Both processes use this single class, or one day one would write
/// <c>agent.alive</c> and the other look for <c>agent.heartbeat</c>.
/// </summary>
public static class AgentLiveness
{
    public const int CurrentVersion = 1;

    /// <summary>Written by the agent (inside %ProgramData%\oXeio\).</summary>
    public const string HeartbeatFileName = "agent.alive";

    /// <summary>
    /// The agent holds this open with <c>FileShare.None</c> for its whole life: this is the
    /// single-instance interlock (see the comment on <see cref="RestartLadder"/>).
    /// </summary>
    public const string AgentLockFileName = "agent.lock";

    /// <summary>The same technique so the watchdog itself does not run twice.</summary>
    public const string WatchdogLockFileName = "watchdog.lock";

    /// <summary>A visible sign of having given up.</summary>
    public const string AlarmFileName = "watchdog.alarm";

    public const string WatchdogLogFileName = "watchdog.log";

    /// <summary>The installer/uninstaller can create this file to stop the watchdog politely.</summary>
    public const string StopFileName = "watchdog.stop";

    /// <summary>How often the agent writes.</summary>
    public static TimeSpan HeartbeatInterval => TimeSpan.FromSeconds(15);

    /// <summary>
    /// Staler than this and the agent is considered wedged: 8 writes in a row missed.
    ///
    /// Do <b>not</b> set it to 2 or 3 times the interval. A full AV scan, a momentary disk
    /// hiccup or one long GC pause can make a write or two get missed. Using 8 times the
    /// interval cuts the risk of wrongly killing a healthy agent; the price is a 2-minute
    /// delay in catching a real wedge, which is negligible against the monthly 208 hours.
    /// </summary>
    public static TimeSpan StaleAfter => TimeSpan.FromSeconds(120);

    /// <summary>How often the watchdog looks.</summary>
    public static TimeSpan CheckInterval => TimeSpan.FromSeconds(30);

    public static string Format(AgentHeartbeat beat)
    {
        ArgumentNullException.ThrowIfNull(beat);

        // InvariantCulture is mandatory. If numbers were written in non-Latin digits (Bengali, say)
        // under a matching locale, the watchdog's parse would fail and a healthy agent would be killed
        // as having "no heartbeat".
        return string.Create(
            CultureInfo.InvariantCulture,
            $"v={beat.Version} pid={beat.ProcessId} session={beat.SessionId} unbiased={beat.UnbiasedMs} utc={beat.WrittenAtUtc.UtcDateTime:O}");
    }

    /// <summary>
    /// <c>null</c> for a broken or incomplete line.
    ///
    /// Unknown fields are ignored on purpose: if an updated agent adds a new field, an old
    /// watchdog must not fail to parse and throw the whole fleet into a restart loop. The
    /// moment of an update is the most fragile one.
    /// </summary>
    public static AgentHeartbeat? TryParse(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;

        int? version = null;
        int? pid = null;
        uint? session = null;
        long? unbiased = null;
        DateTimeOffset? utc = null;

        foreach (var token in line.Split(
                     ' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = token.IndexOf('=');
            if (eq <= 0 || eq == token.Length - 1) continue;

            var key = token[..eq];
            var value = token[(eq + 1)..];

            switch (key)
            {
                case "v":
                    if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v))
                        version = v;
                    break;

                case "pid":
                    if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p))
                        pid = p;
                    break;

                case "session":
                    if (uint.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var s))
                        session = s;
                    break;

                case "unbiased":
                    if (long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var u))
                        unbiased = u;
                    break;

                case "utc":
                    if (DateTimeOffset.TryParse(
                            value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var t))
                        utc = t;
                    break;
            }
        }

        // A half-written file (the agent died midway through writing) is stopped here.
        // A heartbeat without pid or unbiased is meaningless.
        if (version is null || pid is not > 0 || unbiased is not >= 0) return null;

        return new AgentHeartbeat
        {
            Version = version.Value,
            ProcessId = pid.Value,
            SessionId = session ?? 0,
            UnbiasedMs = unbiased.Value,
            WrittenAtUtc = utc ?? DateTimeOffset.MinValue,
        };
    }

    /// <summary>
    /// How old the heartbeat is. <c>null</c> means "not from this boot", i.e. unusable.
    ///
    /// A negative age must <b>not</b> be treated as "very fresh". The unbiased counter never
    /// goes backwards within one boot, so a future value means the file was written in an
    /// <b>earlier boot</b> (after a reboot the file stays on disk and the counter starts from
    /// zero). Treating it as fresh would make the watchdog think a dead agent healthy forever
    /// and never start it, so after a reboot nobody's time would be counted.
    /// </summary>
    public static TimeSpan? Age(AgentHeartbeat beat, long nowUnbiasedMs)
    {
        ArgumentNullException.ThrowIfNull(beat);

        return nowUnbiasedMs < beat.UnbiasedMs
            ? null
            : TimeSpan.FromMilliseconds(nowUnbiasedMs - beat.UnbiasedMs);
    }
}
