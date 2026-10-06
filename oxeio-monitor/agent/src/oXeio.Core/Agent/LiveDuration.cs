namespace oXeio.Core.Agent;

/// <summary>
/// A <b>running</b> clock on screen: the counted number jumps up, but must be shown ticking
/// every second.
///
/// <b>Why this is needed:</b> <see cref="AgentStatus.ActiveToday"/> is not a running number.
/// It grows in two ways: when a server heartbeat brings a new <c>TodayActiveSec</c>, or when
/// the agent's own counter grows after a segment is <b>closed</b>. Both happen in bursts. So
/// even with seconds on the window (<c>2:27:14</c>), the figure would sit unchanged for
/// minutes on end. The owner noticed exactly this: after login the seconds do not change.
///
/// The problem shows up <b>after</b> signing in, which makes sense: before that the number
/// came from the agent's own counter, and afterwards it comes from the server's heartbeat,
/// which changes even less often.
///
/// This class's job: <b>the counted number plus the time elapsed since</b>.
/// It keeps state (what was shown before), so it is not <c>static</c>, but it has no clock,
/// I/O or timer; time always arrives as a parameter. So all of it can be covered by unit tests.
/// </summary>
public sealed class LiveDuration
{
    /// <summary>
    /// The most that is added on its own between two snapshots.
    ///
    /// This ceiling is <b>essential</b>. If the agent's inner loop stops (while the window keeps
    /// drawing), <c>counted</c> goes stale, and without a ceiling the window would
    /// <b>invent hours on end</b>, lying about the very number payroll is computed from.
    ///
    /// Careful: <b>10 minutes, not 5.</b> It used to be 5, and that was the second cause of
    /// "seconds get stuck": status is published on the rhythm of heartbeats/segments, and
    /// both have a maximum gap of exactly 5 minutes. With the ceiling equal to the gap, the
    /// clock would stall right at the last moment. The ceiling is now <b>twice</b> the gap.
    ///
    /// When the ceiling is hit the number freezes, which is the honest answer: we do not know.
    /// (The tray's "Sync" field is already showing trouble by then.)
    /// </summary>
    public static readonly TimeSpan MaxDrift = TimeSpan.FromMinutes(10);

    private readonly TimeSpan _maxDrift;
    private TimeSpan _counted = TimeSpan.MinValue;
    private TimeSpan _shown = TimeSpan.Zero;

    public LiveDuration(TimeSpan? maxDrift = null) => _maxDrift = maxDrift ?? MaxDrift;

    /// <summary>What goes on screen at this moment.</summary>
    /// <param name="counted">What has <b>really</b> been counted so far.</param>
    /// <param name="countedAt">When that number was measured. If <c>null</c>, nothing is
    /// added on its own: without a known anchor, time cannot be invented.</param>
    /// <param name="counting">Whether counting is really under way right now (ACTIVE, not
    /// paused, signed in). While idle the clock <b>should stay stopped</b>: the rule is
    /// "no hand movement for 60 seconds stops counting".</param>
    public TimeSpan Next(
        TimeSpan counted, DateTimeOffset? countedAt, DateTimeOffset now, bool counting)
    {
        if (counted < TimeSpan.Zero) counted = TimeSpan.Zero;

        // The counted number went backwards: Dhaka midnight passed (today's total is zero), or
        // the server sent a correction. The previously shown value must not be kept then, or
        // the window would show yesterday's total all day.
        if (counted < _counted) _shown = counted;
        _counted = counted;

        var candidate = counted;

        if (counting && countedAt is { } at)
        {
            var elapsed = now - at;

            // Negative means the machine clock moved backwards: adding nothing is safest
            // (clock drift is tracked separately in the agent anyway).
            if (elapsed > TimeSpan.Zero)
            {
                candidate = counted + (elapsed > _maxDrift ? _maxDrift : elapsed);
            }
        }

        // <b>Never goes backwards.</b> The heartbeat's number is the sum of uploaded segments,
        // so it sometimes comes in <b>lower</b> than our own count (something is still in the
        // queue). Without max, the clock on screen would step back exactly then, and for a
        // person who sees "I worked, yet the time went down" the whole system would become
        // unbelievable.
        if (candidate > _shown) _shown = candidate;

        return _shown;
    }
}
