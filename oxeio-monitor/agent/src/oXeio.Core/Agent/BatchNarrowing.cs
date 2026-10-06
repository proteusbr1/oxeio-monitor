namespace oXeio.Core.Agent;

/// <summary>
/// <b>One bad record must not cause 499 good ones to be thrown away.</b>
///
/// The server validates the whole batch at once. If one of 500 has a <c>windowTitle</c> over
/// the limit, <b>the whole batch</b> gets a 400, and a 400 means <see cref="SyncOutcome.Permanent"/>:
/// "this will never be accepted, drop it".
///
/// A naive implementation would abandon the whole lease. One bad record would then cost
/// <b>several hours of everyone else's work</b>, and nowhere would it show, because from the
/// server's side everything is normal.
///
/// So on <c>Permanent</c> the batch is halved and retried: 500 → 250 → … → 1. If a
/// <c>Permanent</c> still comes back with just 1 record, it is <b>then</b> certain that the
/// fault is that record's own, and only that one is dropped.
///
/// Getting from 500 down to 1 takes 8 steps. <see cref="RetryPolicy.Default"/> has no limit on
/// attempts (only the 30-day age), so nothing is lost in these steps.
/// </summary>
public sealed class BatchNarrowing(int fullSize)
{
    /// <summary>Cannot go below one: that is the smallest verifiable unit.</summary>
    public const int MinSize = 1;

    private int _current = Guard(fullSize);

    /// <summary>How many records the next attempt will use.</summary>
    public int Current => _current;

    /// <summary>
    /// A single record is being tried right now, so the next <c>Permanent</c> is without doubt
    /// that record's fault.
    /// </summary>
    public bool IsIsolated => _current <= MinSize;

    /// <summary>The batch went through: return to the full size.</summary>
    public void OnSuccess() => _current = Guard(fullSize);

    /// <summary>
    /// Temporary failure (network, 500, 429): the size is <b>not changed</b>. The batch is not
    /// at fault, so shrinking gains nothing; when the link returns, draining at full size is faster.
    /// </summary>
    public void OnTransient() { }

    /// <summary>The batch contains a bad record: halve it and look again.</summary>
    public void OnPermanent()
    {
        if (_current <= MinSize) return;
        _current = Math.Max(MinSize, _current / 2);
    }

    /// <summary>
    /// After the bad record is dropped: return to the full size.
    ///
    /// Important: this return matters. Without it, one bad record would mean sending one record
    /// at a time forever; a backlog of 50,000 rows would hit the rate limit and take days.
    /// </summary>
    public void OnIsolatedDropped() => _current = Guard(fullSize);

    private static int Guard(int size) =>
        size < MinSize ? MinSize
        : size > SyncLimits.MaxBatchSize ? SyncLimits.MaxBatchSize
        : size;
}
