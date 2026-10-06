using oXeio.Core.Agent;
using oXeio.Core.Models;
using oXeio.Core.Time;

namespace oXeio.Core.Apps;

/// <summary>The window in front at one moment: whatever can be read from Win32.</summary>
public sealed record WindowSample
{
    /// <summary>E.g. <c>chrome.exe</c>. If empty, the sample is dropped.</summary>
    public required string ProcessName { get; init; }

    /// <summary>E.g. "Google Chrome". <c>null</c> if not found.</summary>
    public string? AppName { get; init; }

    public string? WindowTitle { get; init; }

    /// <summary>Raw text read from the address bar: it may still hold a full URL here.</summary>
    public string? RawUrl { get; init; }

    public bool IsBrowser { get; init; }
}

/// <summary>
/// Which app, for how long (D01–D04).
///
/// <b>Platform-free:</b> reading from Win32 is done in <c>oXeio.Agent/Apps/</c>; only the
/// rules are here, so all of it can be verified in unit tests.
///
/// Four rules:
/// <list type="number">
/// <item>While the same window stays in front there is a single record, not one per second</item>
/// <item><b>Under 5 seconds is dropped</b> (D04): this filters alt-tab storms</item>
/// <item>Nothing is counted unless ACTIVE: which app was in front during idle time is meaningless</item>
/// <item>A full URL never goes out, only the domain ([ADR-013](../../../../docs/05-Options-Decisions.md))</item>
/// </list>
/// </summary>
public sealed class AppUsageTracker(
    TimeSpan? minDuration = null,
    TimeSpan? maxDuration = null,
    Func<Guid>? newUuid = null)
{
    /// <summary>
    /// D04: if the window was in front for less than this, no record is made.
    ///
    /// Someone alt-tabbing to look for a file touches 10 windows; recording each would put ten
    /// one-second rows in the report and bury the real picture.
    /// </summary>
    public static readonly TimeSpan DefaultMinDuration = TimeSpan.FromSeconds(5);

    /// <summary>
    /// As with segments: even while working in one app for a long time, records come out
    /// regularly, or a crash would lose all of it ([G53](../../../../docs/08-Gap-Analysis.md)).
    /// </summary>
    public static readonly TimeSpan DefaultMaxDuration = TimeSpan.FromMinutes(5);

    private readonly TimeSpan _min = minDuration ?? DefaultMinDuration;
    private readonly TimeSpan _max = maxDuration ?? DefaultMaxDuration;
    private readonly Func<Guid> _newUuid = newUuid ?? Guid.NewGuid;

    private WindowSample? _open;
    private DateTimeOffset _openedAt;

    /// <summary>
    /// <b>R22a</b>: the state in which the open slice started.
    ///
    /// When the state changes the slice is <b>cut right there</b> and a new one starts.
    /// Otherwise one row would be half ACTIVE and half IDLE, and the question "does this time
    /// count" would have no single answer.
    /// </summary>
    private SegmentState _openState = SegmentState.Active;

    /// <summary>
    /// The window being counted right now: for diagnostics and A07.
    ///
    /// Always <c>null</c> unless ACTIVE, because <see cref="Observe"/> closes the open record
    /// in other states. Screenshots are taken only while ACTIVE too (A04), so no extra
    /// condition is needed when pairing this with a picture.
    /// </summary>
    public WindowSample? Current => _open;

    /// <summary>Which window is being counted now: for diagnostics.</summary>
    public string? CurrentProcess => _open?.ProcessName;

    /// <summary>
    /// Called on every sample (when the window changes, or on the regular tick).
    /// </summary>
    /// <param name="sample">What is in front now. <c>null</c> if nothing.</param>
    /// <param name="state">The agent's current state: nothing is counted unless ACTIVE.</param>
    public IReadOnlyList<AppUsageRecord> Observe(
        WindowSample? sample, DateTimeOffset now, SegmentState state)
    {
        var closed = new List<AppUsageRecord>();

        /**
         * <b>R22a: IDLE is observed too, but not counted.</b>
         *
         * The condition here used to be <c>state != Active</c>, so everything closed the moment
         * ACTIVE was left. As a result no row existed inside an idle segment: measured in the
         * field, the overlap that did show up averaged 59 seconds, just the ghost at the head of
         * the segment. That lost the answer to "what was in front during this idle time?" and
         * left no way to recognize meetings.
         *
         * <b>LOCKED is still excluded</b>: with the screen locked no window is in front, and
         * what could be read then was the lock screen. This is also right for privacy: there is
         * no reason to read the screen of someone who locked it and walked away.
         *
         * The rule "leaving Excel open and going to lunch is not work" is <b>not broken</b>:
         * those slices are now stored with <c>State = Idle</c>, and every place that reads them
         * filters to ACTIVE only. Being recorded and being counted are two different things.
         */
        if (state == SegmentState.Locked || sample is null)
        {
            Close(closed, now);
            return closed;
        }

        if (_open is null)
        {
            Open(sample, now, state);
            return closed;
        }

        // The state changed: cut the slice here and start in the new state, or one row would
        // be half ACTIVE and half IDLE.
        if (state != _openState)
        {
            Close(closed, now);
            Open(sample, now, state);
            return closed;
        }

        // Same window: only split if it has grown long
        if (SameWindow(_open, sample))
        {
            SplitIfLong(closed, now);
            return closed;
        }

        Close(closed, now);
        Open(sample, now, state);
        return closed;
    }

    /// <summary>The agent is stopping or the session is ending: close whatever is open.</summary>
    public IReadOnlyList<AppUsageRecord> CloseAll(DateTimeOffset now)
    {
        var closed = new List<AppUsageRecord>();
        Close(closed, now);
        return closed;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /// <summary>
    /// Whether two samples are the same "use".
    ///
    /// In a browser a <b>changed domain means a new record</b> even though the process is the
    /// same. Otherwise there would be one "chrome.exe 8 hours" row all day and D08 (top 10
    /// sites) could not be built at all.
    ///
    /// A changed title is not a new record: scrolling on the same page changes the title,
    /// and the record count would swell for no reason.
    /// </summary>
    private static bool SameWindow(WindowSample a, WindowSample b) =>
        string.Equals(a.ProcessName, b.ProcessName, StringComparison.OrdinalIgnoreCase)
        && string.Equals(DomainOf(a), DomainOf(b), StringComparison.OrdinalIgnoreCase);

    private static string? DomainOf(WindowSample s) =>
        DomainParser.LooksPrivate(s.WindowTitle) ? null : DomainParser.Extract(s.RawUrl);

    private void Open(WindowSample sample, DateTimeOffset now, SegmentState state)
    {
        _open = sample;
        _openedAt = now;
        _openState = state;
    }

    private void SplitIfLong(List<AppUsageRecord> closed, DateTimeOffset now)
    {
        while (now - _openedAt >= _max)
        {
            var boundary = _openedAt + _max;
            Emit(closed, _openedAt, boundary);
            _openedAt = boundary;
        }

        // Split at midnight too: one record cannot span two work_dates
        var midnight = WorkTime.NextLocalMidnight(_openedAt);
        while (midnight <= now)
        {
            Emit(closed, _openedAt, midnight);
            _openedAt = midnight;
            midnight = WorkTime.NextLocalMidnight(_openedAt);
        }
    }

    private void Close(List<AppUsageRecord> closed, DateTimeOffset now)
    {
        if (_open is null) return;

        SplitIfLong(closed, now);
        Emit(closed, _openedAt, now);

        _open = null;
    }

    private void Emit(List<AppUsageRecord> closed, DateTimeOffset from, DateTimeOffset to)
    {
        if (_open is null || to <= from) return;

        var duration = to - from;

        // D04: under 5 seconds, no record is made
        if (duration < _min) return;

        var isPrivate = DomainParser.LooksPrivate(_open.WindowTitle);

        closed.Add(new AppUsageRecord
        {
            ClientUuid = _newUuid(),
            StartedAt = from,
            EndedAt = to,
            DurationSec = (int)Math.Round(duration.TotalSeconds),
            ProcessName = _open.ProcessName,
            AppName = _open.AppName,

            // Private browsing drops the title too: the title holds the page name, so keeping
            // it would keep the same information indirectly.
            WindowTitle = isPrivate ? null : _open.WindowTitle,
            Domain = isPrivate ? null : DomainParser.Extract(_open.RawUrl),
            IsBrowser = _open.IsBrowser,

            // R22a: the state it was observed in. Use `_openState`, not the `state` parameter:
            // the state the slice **started** in is its state, and when the state changes the
            // slice is cut anyway (Observe).
            State = _openState,
        });
    }
}
