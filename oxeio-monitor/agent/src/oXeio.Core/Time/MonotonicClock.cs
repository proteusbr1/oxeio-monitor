using System.Diagnostics;

namespace oXeio.Core.Time;

/// <summary>
/// Time that does not go backwards even when the clock is changed.
///
/// Why needed: with <c>DateTimeOffset.UtcNow</c>, if someone set the PC's clock back, a
/// segment's length would come out negative, or it would jump suddenly on an NTP sync.
/// Here the start time is captured once and then advanced with <see cref="Stopwatch"/> (QPC),
/// which only ever moves forward (G7, ADR section 3.2).
///
/// <b>This clock keeps running during sleep too.</b> According to Microsoft's documentation,
/// QueryPerformanceCounter counts time in every kind of sleep ("standby, hibernate,
/// connected standby"), and <see cref="Stopwatch"/> uses QPC.
///
/// That works in our favor: after waking, <c>Now</c> matches real time, <b>and</b> it helps
/// detect sleep: if in one tick this clock advanced 8 hours instead of 1 second, the PC was
/// asleep in between (<see cref="Tracking.SleepGapDetector"/>).
/// </summary>
public sealed class MonotonicClock
{
    private readonly DateTimeOffset _anchor;
    private readonly Stopwatch _elapsed;

    public MonotonicClock(DateTimeOffset anchor)
    {
        _anchor = anchor.ToUniversalTime();
        _elapsed = Stopwatch.StartNew();
    }

    /// <summary>Starts from the real clock, then only goes forward.</summary>
    public static MonotonicClock StartNow() => new(DateTimeOffset.UtcNow);

    public DateTimeOffset Now => _anchor + _elapsed.Elapsed;

    /// <summary>Time elapsed since the start: unchanged even if the clock changes.</summary>
    public TimeSpan Elapsed => _elapsed.Elapsed;
}
