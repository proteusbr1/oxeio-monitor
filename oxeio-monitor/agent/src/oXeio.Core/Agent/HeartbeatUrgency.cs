namespace oXeio.Core.Agent;

/// <summary>
/// <b>When to tell the server that the state changed.</b> Pure rules, no I/O.
///
/// <b>This came from a real complaint.</b> The owner reported that after being idle, moving
/// the mouse, clicking or pressing a key still took <b>10-15 seconds</b> to show "Working"
/// on the board.
///
/// It was not a bug but the <b>rhythm</b>: the agent notices within a second, but the server
/// only learns on a heartbeat, which goes out every 15 seconds. The employee had come back and
/// started working while the board still said they had stopped.
///
/// A short delay sounds minor, but the damage is to trust: the owner sees someone as "Idle"
/// on screen, then walks over and finds them typing. After that happens twice, the whole
/// board is no longer trusted.
///
/// So when the state changes a heartbeat goes out <b>immediately</b>, but never more often
/// than <see cref="MinGap"/>.
/// </summary>
public static class HeartbeatUrgency
{
    /// <summary>
    /// The minimum interval between two heartbeats.
    ///
    /// Without it, a flapping state (someone works for a second, stops for a second, which is
    /// very normal when taking notes while reading) would make the agent hit the server every
    /// second. Across 15 PCs that is a wave on the server for zero gain: to a human eye 3
    /// seconds and 0 seconds are the same.
    /// </summary>
    public static readonly TimeSpan MinGap = TimeSpan.FromSeconds(3);

    /// <summary>
    /// How long until the next heartbeat.
    /// </summary>
    /// <param name="now">Now (monotonic clock).</param>
    /// <param name="lastBeatAt">When the last heartbeat went out.</param>
    /// <param name="normal">The normal interval (from the server's config).</param>
    /// <param name="stateChanged">Whether the state changed since the last heartbeat.</param>
    public static TimeSpan Next(
        DateTimeOffset now,
        DateTimeOffset lastBeatAt,
        TimeSpan normal,
        bool stateChanged)
    {
        // The state did not change: keep the normal rhythm
        if (!stateChanged) return Remaining(now, lastBeatAt, normal);

        /**
         * It changed, but a beat has only just gone out, so still wait until <see cref="MinGap"/>.
         * Returning zero would make the loop spin non-stop while the state flaps.
         */
        var since = now - lastBeatAt;

        // Negative means the clock went backwards and the last beat is "in the future". Then
        // `MinGap - since` would come out as minutes or hours, so the urgent news would be
        // the most delayed of all.
        if (since < TimeSpan.Zero) return TimeSpan.Zero;

        return since < MinGap ? MinGap - since : TimeSpan.Zero;
    }

    /**
     * <b>Clamped on both sides, and the second side was caught by a test.</b>
     *
     * The first version only handled the negative side. The real danger is the other way:
     * when the clock steps back (NTP correction), <c>lastBeatAt</c> becomes a time in the
     * <b>future</b>, and with a 10-minute clock jump the wait would come out as
     * <b>615 seconds</b>: heartbeats stop, and G01 ("agent silent for 10 minutes") fires on
     * every machine.
     *
     * So the ceiling is <c>normal</c>: waiting longer than one normal interval is never
     * reasonable.
     */
    private static TimeSpan Remaining(
        DateTimeOffset now,
        DateTimeOffset lastBeatAt,
        TimeSpan normal)
    {
        var due = lastBeatAt + normal - now;

        if (due <= TimeSpan.Zero) return TimeSpan.Zero;
        return due > normal ? normal : due;
    }
}
