namespace oXeio.Core.Agent;

/// <summary>
/// When the tray icon turns yellow and when red (J07).
///
/// <b>Why time-based, not failure-count-based:</b> "5 failures in a row" sounds clear, but
/// because of backoff 5 failures can take 2 minutes or 40 minutes. What staff or an admin want
/// to know is <b>"how long has my data been stuck"</b>: time, not a count.
///
/// <b>Why an empty queue is always healthy:</b> the icon must not turn red at 3 a.m. just
/// because there is nothing to send. Red is meaningful only when data is really stuck.
/// </summary>
public sealed record SyncHealthPolicy(TimeSpan DegradedAfter, TimeSpan FailingAfter)
{
    /// <summary>
    /// 15 minutes, three screenshot slots. Any less and ordinary office network blips would
    /// change the icon color, at which point the color change would mean nothing.
    /// </summary>
    public static readonly TimeSpan DefaultDegradedAfter = TimeSpan.FromMinutes(15);

    /// <summary>
    /// 2 hours: an ordinary network problem would have cleared by now. Still stuck means the
    /// problem will not clear unless someone looks at it.
    /// </summary>
    public static readonly TimeSpan DefaultFailingAfter = TimeSpan.FromHours(2);

    public static SyncHealthPolicy Default { get; } =
        new(DefaultDegradedAfter, DefaultFailingAfter);

    /// <param name="lastSuccessAt">The last successful sync. <c>null</c> if never.</param>
    /// <param name="startedAt">When the agent started; before the first sync this is the baseline.</param>
    /// <param name="queueDepth">How many rows are waiting to be sent.</param>
    /// <param name="revoked">Whether the server has revoked this device.</param>
    public SyncHealth Evaluate(
        DateTimeOffset? lastSuccessAt,
        DateTimeOffset startedAt,
        int queueDepth,
        bool revoked,
        DateTimeOffset now)
    {
        // First of all: once revoked, nothing else matters.
        if (revoked) return SyncHealth.Revoked;

        // Nothing to send means nothing can be stuck.
        if (queueDepth <= 0) return SyncHealth.Ok;

        // Never succeeded: count from the start time. Otherwise a freshly installed agent
        // would show red from the first minute.
        var since = now - (lastSuccessAt ?? startedAt);

        if (since >= FailingAfter) return SyncHealth.Failing;
        if (since >= DegradedAfter) return SyncHealth.Degraded;

        return SyncHealth.Ok;
    }

    /// <summary>What staff will be shown, including J07's specified sentence.</summary>
    public static string? Describe(SyncHealth health, int queueDepth) => health switch
    {
        SyncHealth.Ok => null,
        SyncHealth.Degraded => $"Reaching the server is slow — {queueDepth} waiting",
        SyncHealth.Failing => $"Can't reach server, data saved locally ({queueDepth} waiting)",
        SyncHealth.Revoked => "This device has been switched off — tell the office",
        _ => null,
    };
}
