namespace oXeio.Core.Time;

/// <summary>One change of offset: from <see cref="At"/> on, wall clock = UTC + <see cref="OffsetMinutes"/>.</summary>
public sealed record ZoneTransition
{
    public required DateTimeOffset At { get; init; }
    public required int OffsetMinutes { get; init; }
}

/// <summary>
/// The work-day time zone: which date and which hour it is there.
///
/// An exact mirror of the server's <c>server/src/agent/util/work-time.ts</c>.
/// Without the same rule on both sides, the agent and the server would derive different <c>work_date</c>s.
///
/// Daylight saving: the server sends its zone's offset changes for about a year ahead
/// (<c>zoneTransitions</c>), computed from its own tz database. The agent looks the
/// offset up in that table, so days are cut exactly where the server cuts them,
/// without relying on Windows' time-zone data (which can lag behind a country's
/// change of rules). With no table (an older server) it uses the single offset,
/// as before. Before any config arrives the zone is UTC (the server's default too).
/// </summary>
public static class WorkTime
{
    /// <summary>UTC — what the agent uses before any config arrives (the server's default too).</summary>
    public static TimeSpan DefaultOffset { get; private set; } = TimeSpan.Zero;

    public static string DefaultTimeZone { get; private set; } = "UTC";

    /// <summary>
    /// Real offsets run from UTC−12:00 to UTC+14:00. Anything outside is a
    /// broken config, and applying it would move every work date.
    /// </summary>
    public const int MinOffsetMinutes = -12 * 60;
    public const int MaxOffsetMinutes = 14 * 60;

    /// <summary>A year has two changes; a table much longer than this is not from our server.</summary>
    public const int MaxTransitions = 64;

    // Read by the tracking loop and the UI thread at once; one immutable
    // object swapped atomically, so nobody sees a new offset with an old name.
    private sealed record Zone(string Name, TimeSpan Offset, ZoneTransition[] Transitions);

    private static volatile Zone _zone = new(DefaultTimeZone, DefaultOffset, []);

    /// <summary>The work-day offset right now.</summary>
    public static TimeSpan Offset => OffsetAt(DateTimeOffset.UtcNow);

    /// <summary>IANA name of the work-day zone, e.g. <c>Europe/Lisbon</c>.</summary>
    public static string TimeZoneName => _zone.Name;

    /// <summary>How many offset changes are known (0 = one fixed offset).</summary>
    public static int TransitionCount => _zone.Transitions.Length;

    /// <summary>
    /// Short place name for the tray: <c>Europe/Lisbon</c> → <c>Lisbon</c>,
    /// <c>America/Sao_Paulo</c> → <c>Sao Paulo</c>.
    /// </summary>
    public static string Label
    {
        get
        {
            var name = _zone.Name;
            var slash = name.LastIndexOf('/');
            return (slash < 0 ? name : name[(slash + 1)..]).Replace('_', ' ');
        }
    }

    /// <summary>
    /// Switches the work-day zone. <c>false</c> (and nothing changes) when an
    /// offset is out of range, the name is empty, or the table is not in time order.
    /// </summary>
    public static bool TrySet(string? timeZone, int offsetMinutes, IReadOnlyList<ZoneTransition>? transitions = null)
    {
        if (string.IsNullOrWhiteSpace(timeZone)) return false;
        if (!InRange(offsetMinutes)) return false;

        var table = transitions?.ToArray() ?? [];
        if (table.Length > MaxTransitions) return false;
        for (var i = 0; i < table.Length; i++)
        {
            if (!InRange(table[i].OffsetMinutes)) return false;
            if (i > 0 && table[i].At <= table[i - 1].At) return false;
        }

        _zone = new Zone(timeZone.Trim(), TimeSpan.FromMinutes(offsetMinutes), table);
        return true;
    }

    private static bool InRange(int minutes) => minutes is >= MinOffsetMinutes and <= MaxOffsetMinutes;

    /// <summary>
    /// One line to keep on disk, so a restart without network still counts days
    /// in the last zone it was told: <c>America/Sao_Paulo|-180</c>, plus the
    /// offset changes when there are any: <c>Europe/Lisbon|0|1774746000000=60;1792890000000=0</c>
    /// (Unix milliseconds = minutes).
    /// </summary>
    public static string ToMemoryLine()
    {
        var zone = _zone;
        var line = $"{zone.Name}|{(int)zone.Offset.TotalMinutes}";
        if (zone.Transitions.Length == 0) return line;

        var table = string.Join(';', zone.Transitions.Select(t =>
            $"{t.At.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture)}=" +
            t.OffsetMinutes.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        return $"{line}|{table}";
    }

    /// <summary>
    /// Applies a line written by <see cref="ToMemoryLine"/>. Anything else
    /// (missing file, a hand-edited or truncated line) is <c>false</c> and the
    /// zone stays as it is.
    /// </summary>
    public static bool TryRestore(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return false;

        var parts = line.Split('|');
        if (parts.Length is < 2 or > 3 || parts[0].Length == 0) return false;
        if (!TryInt(parts[1], out var minutes)) return false;

        var table = new List<ZoneTransition>();
        if (parts.Length == 3)
        {
            foreach (var entry in parts[2].Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = entry.IndexOf('=');
                if (eq <= 0
                    || !long.TryParse(entry.AsSpan(0, eq), System.Globalization.NumberStyles.AllowLeadingSign,
                        System.Globalization.CultureInfo.InvariantCulture, out var ms)
                    || !TryInt(entry[(eq + 1)..], out var offset))
                {
                    return false;
                }

                DateTimeOffset at;
                try { at = DateTimeOffset.FromUnixTimeMilliseconds(ms); }
                catch (ArgumentOutOfRangeException) { return false; }
                table.Add(new ZoneTransition { At = at, OffsetMinutes = offset });
            }
        }

        return TrySet(parts[0], minutes, table);
    }

    private static bool TryInt(string text, out int value) =>
        int.TryParse(text.AsSpan().Trim(), System.Globalization.NumberStyles.AllowLeadingSign,
            System.Globalization.CultureInfo.InvariantCulture, out value);

    /// <summary>Back to the default zone — for tests.</summary>
    public static void Reset() => _zone = new Zone(DefaultTimeZone, DefaultOffset, []);

    /// <summary>
    /// Tests only: the zone <see cref="Reset"/> returns to. The test projects pin a fixed
    /// UTC+6 zone (<c>Etc/GMT-6</c>) once, at load, so their fixed instants keep meaning the
    /// same local times whatever the product default is. Never called by the agent itself.
    /// </summary>
    public static void UseDefaultForTests(string timeZone, int offsetMinutes)
    {
        DefaultTimeZone = timeZone;
        DefaultOffset = TimeSpan.FromMinutes(offsetMinutes);
        Reset();
    }

    /// <summary>
    /// The offset in force at that instant: the last change at or before it. Before
    /// the table starts, its first offset; with no table, the single offset.
    /// </summary>
    public static TimeSpan OffsetAt(DateTimeOffset instant)
    {
        var zone = _zone;
        var table = zone.Transitions;
        if (table.Length == 0) return zone.Offset;

        int lo = 0, hi = table.Length - 1, found = 0;
        while (lo <= hi)
        {
            var mid = (lo + hi) / 2;
            if (table[mid].At <= instant) { found = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return TimeSpan.FromMinutes(table[found].OffsetMinutes);
    }

    /// <summary>The wall clock at that moment, as a plain <see cref="DateTime"/>.</summary>
    private static DateTime WallOf(DateTimeOffset instant) =>
        (instant.ToUniversalTime() + OffsetAt(instant)).UtcDateTime;

    /// <summary>The date, in the work time zone, that this moment falls on.</summary>
    public static DateOnly WorkDateOf(DateTimeOffset instant) =>
        DateOnly.FromDateTime(WallOf(instant));

    /// <summary>What time it is on the work zone's clock at that moment.</summary>
    public static TimeOnly LocalTimeOf(DateTimeOffset instant) =>
        TimeOnly.FromDateTime(WallOf(instant));

    /// <summary>
    /// The first moment of the next work day after that moment (section 2.1(a)).
    ///
    /// Careful: not "today's midnight + 24 h": with daylight saving a day can be 23
    /// or 25 hours long, and a midnight can be skipped (the day then starts at 01:00).
    /// Found by bisection, exactly as the server's <c>zone.ts</c> does.
    /// </summary>
    public static DateTimeOffset NextLocalMidnight(DateTimeOffset instant)
    {
        var next = WorkDateOf(instant).AddDays(1);
        var label = new DateTimeOffset(next.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero);

        // offsets lie within −12 h … +14 h, so the answer lies in this window
        var lo = label.AddHours(-16).ToUnixTimeMilliseconds();
        var hi = label.AddHours(14).ToUnixTimeMilliseconds();
        while (hi - lo > 1)
        {
            var mid = lo + (hi - lo) / 2;
            if (WorkDateOf(DateTimeOffset.FromUnixTimeMilliseconds(mid)) >= next) hi = mid;
            else lo = mid;
        }
        return DateTimeOffset.FromUnixTimeMilliseconds(hi);
    }

    public static bool SameWorkDate(DateTimeOffset a, DateTimeOffset b) =>
        WorkDateOf(a) == WorkDateOf(b);
}
