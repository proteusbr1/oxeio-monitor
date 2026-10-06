namespace oXeio.Core.Tracking;

/// <summary>
/// Sleeping time must not be counted as work (G3).
///
/// <b>Core principle: the clock is the source of truth, events are only a quick way to find
/// out.</b> There is no path that says "no suspend event, so work must have been happening".
/// When a PC sleeps from a flat battery or heat, Windows sends no notification at all.
///
/// Three independent measures are compared:
/// <list type="bullet">
/// <item><b>biased</b>: <c>GetTickCount64</c>, counts the sleep time too</item>
/// <item><b>unbiased</b>: <c>QueryUnbiasedInterruptTime</c>, does not count sleep time</item>
/// <item><b>monotonic</b>: QPC, intact even if the clock is changed</item>
/// </list>
/// A large gap between the two shows that the PC was asleep in between, with no event needed.
///
/// If a laptop is shut at 5 p.m. and opened at 9 a.m., this is what prevents 16 hours of bogus work.
/// </summary>
public sealed class SleepGapDetector
{
    private readonly TimeSpan _interval;
    private readonly double _tolerance;

    private bool _primed;
    private ulong _lastBiasedMs;
    private ulong _lastUnbiasedMs;
    private DateTimeOffset _lastMonotonic;

    /// <param name="interval">The expected gap between ticks (normally 1 second).</param>
    /// <param name="tolerance">A factor allowing for the timer's normal slack.</param>
    public SleepGapDetector(TimeSpan interval, double tolerance = 1.5)
    {
        if (interval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(interval));
        if (tolerance < 1.0) throw new ArgumentOutOfRangeException(nameof(tolerance));

        _interval = interval;
        _tolerance = tolerance;
    }

    /// <param name="BiasedMs">GetTickCount64: includes sleep time.</param>
    /// <param name="UnbiasedMs">QueryUnbiasedInterruptTime: excludes sleep time.</param>
    /// <param name="Monotonic">MonotonicClock.Now।</param>
    public readonly record struct Sample(
        ulong BiasedMs,
        ulong UnbiasedMs,
        DateTimeOffset Monotonic);

    public readonly record struct Gap(
        bool Detected,
        /// <summary>The last moment the PC was really awake: the segment closes here.</summary>
        DateTimeOffset SuspendedAt,
        DateTimeOffset ResumedAt,
        /// <summary>biased minus unbiased, i.e. how long it slept.</summary>
        TimeSpan SleptFor)
    {
        public static readonly Gap None = default;
    }

    public Gap Observe(Sample s)
    {
        if (!_primed)
        {
            Remember(s);
            _primed = true;
            return Gap.None;
        }

        var biasedMs = Delta(s.BiasedMs, _lastBiasedMs);
        var unbiasedMs = Delta(s.UnbiasedMs, _lastUnbiasedMs);
        var monoMs = Math.Max(0, (s.Monotonic - _lastMonotonic).TotalMilliseconds);

        var cap = _interval.TotalMilliseconds * _tolerance;

        // biased jumping means wall-clock time passed; monotonic jumping means the same.
        // Either one is enough, because in S0ix the process itself freezes and no timer runs.
        var detected = biasedMs > cap || monoMs > cap;

        var gap = detected
            ? new Gap(
                Detected: true,
                SuspendedAt: _lastMonotonic,
                ResumedAt: s.Monotonic,
                SleptFor: TimeSpan.FromMilliseconds(Math.Max(0, biasedMs - unbiasedMs)))
            : Gap.None;

        Remember(s);
        return gap;
    }

    /// <summary>When sleep is learned from an event, the clock calculation must start afresh.</summary>
    public void Reset() => _primed = false;

    private void Remember(Sample s)
    {
        _lastBiasedMs = s.BiasedMs;
        _lastUnbiasedMs = s.UnbiasedMs;
        _lastMonotonic = s.Monotonic;
    }

    /// <summary>If a counter goes backwards (it should not) it is treated as zero, not negative.</summary>
    private static double Delta(ulong now, ulong before) =>
        now >= before ? now - before : 0d;
}
