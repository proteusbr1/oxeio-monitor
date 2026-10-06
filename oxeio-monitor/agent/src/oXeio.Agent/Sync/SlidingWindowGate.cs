using System.Diagnostics;

namespace oXeio.Agent.Sync;

/// <summary>
/// "At most N per minute": stopping ourselves <b>before</b> we hit the server's rate limit.
///
/// <b>Why learning from a 429 is not acceptable:</b> 429 is Transient, so that batch goes
/// into backoff and attempts increase. While draining a 50,000-row backlog, a few 429s per
/// minute push backoff up to its 5 minute ceiling, and emptying the queue would take days.
/// The machine that is furthest behind would be the slowest to catch up.
///
/// <b>Why a sliding window, not fixed buckets:</b> with fixed buckets you can send 55 at the
/// end of a minute and 55 at the start of the next; on the server's clock that is 110 in
/// one second, a straight 429.
///
/// Careful: the clock is <see cref="Stopwatch"/> (monotonic), not <c>DateTime</c>. If NTP
/// set the time back, wall-clock accounting would either open the gate or hold it shut
/// forever.
/// </summary>
internal sealed class SlidingWindowGate : IDisposable
{
    private readonly int _permits;
    private readonly long _windowTicks;

    /// <summary>Timestamps of requests sent in the last window. Size is at most <see cref="_permits"/>.</summary>
    private readonly Queue<long> _stamps;

    private readonly SemaphoreSlim _mutex = new(1, 1);
    private bool _disposed;

    public SlidingWindowGate(int permits, TimeSpan window)
    {
        // Careful: 0 or negative permits would mean the gate never opens, so sync stops for
        // good. A config mistake must not be able to cause that, hence at least 1.
        _permits = Math.Max(1, permits);
        _windowTicks = (long)(window.TotalSeconds * Stopwatch.Frequency);
        if (_windowTicks < 1) _windowTicks = Stopwatch.Frequency;
        _stamps = new Queue<long>(_permits);
    }

    public static SlidingWindowGate PerMinute(int permits) =>
        new(permits, TimeSpan.FromMinutes(1));

    /// <summary>
    /// Waits until there is room, then spends one permit and returns.
    ///
    /// Careful: the caller must call this <b>before starting the request's timeout clock</b>.
    /// Called inside the timeout, waiting on the rate limit would count as a "timeout" and
    /// the request would be cancelled before it was even sent.
    /// </summary>
    public async Task WaitAsync(CancellationToken ct)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();

            TimeSpan wait;

            await _mutex.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var now = Stopwatch.GetTimestamp();
                var cutoff = now - _windowTicks;

                while (_stamps.Count > 0 && _stamps.Peek() <= cutoff) _stamps.Dequeue();

                if (_stamps.Count < _permits)
                {
                    _stamps.Enqueue(now);
                    return;
                }

                // As soon as the oldest one leaves the window, a slot frees up
                var freeAt = _stamps.Peek() + _windowTicks;
                wait = TimeSpan.FromSeconds((double)(freeAt - now) / Stopwatch.Frequency);
            }
            finally
            {
                _mutex.Release();
            }

            // Careful: without the lower bound, a small miscalculation would turn this into a
            // busy loop eating a core, and nobody would see it; the machine would just run hot.
            if (wait < TimeSpan.FromMilliseconds(25)) wait = TimeSpan.FromMilliseconds(25);
            if (wait > TimeSpan.FromMinutes(2)) wait = TimeSpan.FromMinutes(2);

            await Task.Delay(wait, ct).ConfigureAwait(false);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _mutex.Dispose();
    }
}
