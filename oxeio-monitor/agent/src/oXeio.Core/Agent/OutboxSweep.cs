namespace oXeio.Core.Agent;

/// <summary>
/// A05: when the queue's disk budget must be applied.
///
/// The rule was already written in the <see cref="oXeio.Core.Agent.OutboxBudget"/> doc:
/// <i>"once at startup, then once an hour, and immediately whenever <c>LastWriteError</c>
/// shows up"</i>. But the rule was never **turned into code**: the caller was never
/// written, so the whole budget system was built and sat idle.
///
/// With it here, all three branches can be covered by unit tests.
/// </summary>
public static class OutboxSweep
{
    public enum Reason
    {
        /// <summary>Not needed now.</summary>
        No,

        /// <summary>The agent has just started: nobody knows how much the queue has grown.</summary>
        Startup,

        /// <summary>The regular sweep.</summary>
        Due,

        /// <summary>
        /// A write failed: the disk is full and space is needed right now. Waiting for the
        /// hourly sweep would silently lose the data of the time in between.
        /// </summary>
        WriteFailed,
    }

    /// <param name="lastSweep">
    /// When it last ran. <see cref="DateTimeOffset.MinValue"/> if it never has.
    /// </param>
    public static Reason Check(
        DateTimeOffset lastSweep,
        DateTimeOffset now,
        TimeSpan every,
        bool hasWriteError)
    {
        // A write failure comes first: it is the only emergency.
        if (hasWriteError) return Reason.WriteFailed;

        if (lastSweep == DateTimeOffset.MinValue) return Reason.Startup;

        // `>=`, not `>`: with `>` a sweep that ran at exactly one hour would slip back by one
        // tick every time, and run a few times fewer by the end of the day.
        return now - lastSweep >= every ? Reason.Due : Reason.No;
    }

    public static bool IsDue(
        DateTimeOffset lastSweep,
        DateTimeOffset now,
        TimeSpan every,
        bool hasWriteError) =>
        Check(lastSweep, now, every, hasWriteError) != Reason.No;
}
