namespace oXeio.Core.Agent;

/// <summary>
/// Durable outbox: stores while offline, uploads in order when the line returns.
///
/// <b>Why lease/ack and not a plain dequeue; this is the whole reason for the interface:</b>
///
/// <code>
/// (a) dequeue → upload   : take the row out, go to upload, and the power fails.
///                          The row is gone and never reached the server. Data is <b>lost</b>.
/// (b) upload → delete    : the upload worked, but the process dies before the 200 arrives.
///                          It sends again next time. Data is <b>duplicated</b>.
/// (c) lease → ack        : the row stays in place, only marked "borrowed".
///                          On a 200, ack deletes it. If we die midway the lease expires
///                          and the row comes back by itself.
/// </code>
///
/// Even in (c) the same data can be <i>sent</i> twice, exactly when the server has written it
/// but we never got the reply. That is not a problem, because every record has a
/// <c>clientUuid</c> and the server does <c>ON CONFLICT DO NOTHING</c> (section 2.1(d)).
/// So sending a duplicate is <b>cheap</b> and losing data is <b>irreparable</b>; hence
/// at-least-once was chosen, not exactly-once.
///
/// Do not assume all methods are called from a single sync worker:
/// <see cref="EnqueueAsync"/> comes from the tracking thread. Implementations must be
/// thread-safe (in SQLite, WAL plus a single write connection is enough).
/// </summary>
public interface IOutboxStore : IAsyncDisposable
{
    /// <summary>Enqueues one row. Returns the new row id.</summary>
    Task<long> EnqueueAsync(OutboxItem item, CancellationToken ct = default);

    /// <summary>
    /// Several rows in <b>a single transaction</b>. If we die midway, either all go in or none:
    /// a half-inserted batch would not be detected later as a gap.
    /// </summary>
    Task<int> EnqueueManyAsync(IReadOnlyList<OutboxItem> items, CancellationToken ct = default);

    /// <summary>
    /// Leases the next batch. <c>null</c> if there is nothing.
    ///
    /// The implementation itself must honor these conditions:
    /// <list type="bullet">
    /// <item>Only rows of <paramref name="kind"/>, <b>oldest first</b> by <see cref="OutboxEntry.EnqueuedAt"/> (section 2.1(d): changing the order breaks sessions on the server, G43)</item>
    /// <item>Skip rows whose <c>notBefore</c> has not arrived yet (see <see cref="RetryAsync"/>)</item>
    /// <item>Skip rows already leased (lease still active)</item>
    /// <item><paramref name="maxItems"/> must never exceed <see cref="SyncLimits.MaxBatchSize"/></item>
    /// </list>
    /// </summary>
    Task<OutboxLease?> LeaseAsync(
        OutboundKind kind,
        int maxItems,
        TimeSpan leaseFor,
        DateTimeOffset now,
        CancellationToken ct = default);

    /// <summary>
    /// The server accepted it (<see cref="SyncOutcome.Success"/>): delete the rows.
    ///
    /// For screenshots, the file at <see cref="OutboxItem.FilePath"/> must be deleted here too.
    /// Deleting only the row would leave orphan .webp files piling up on disk, uncounted by any
    /// budget, and the drive would fill within a couple of months.
    /// Silently ignore an unknown or expired <paramref name="leaseId"/>.
    /// </summary>
    Task AckAsync(Guid leaseId, CancellationToken ct = default);

    /// <summary>
    /// Temporary failure (<see cref="SyncOutcome.Transient"/>): release the lease, increase
    /// <see cref="OutboxEntry.Attempts"/> by one, and do not lease these rows again before
    /// <paramref name="notBefore"/>.
    ///
    /// <paramref name="notBefore"/> comes from <see cref="RetryPolicy.NextAttemptAt"/>.
    /// </summary>
    Task RetryAsync(Guid leaseId, DateTimeOffset notBefore, CancellationToken ct = default);

    /// <summary>
    /// Permanent rejection (<see cref="SyncOutcome.Permanent"/>): delete the rows, but write
    /// them to the log together with <paramref name="reason"/>.
    ///
    /// Do not delete silently. A 422 means the agent is building something the server will
    /// never accept; without a log entry a machine would quietly discard data for months and the
    /// reports would only show "fewer hours".
    /// </summary>
    Task AbandonAsync(Guid leaseId, string reason, CancellationToken ct = default);

    /// <summary>
    /// Reclaims expired leases (after a crash or reboot). Returns how many came back.
    /// Call once at startup, then now and then in the sync loop.
    ///
    /// This is the safety net for (c): without calling it, a batch leased at the time of a
    /// crash would stay stuck forever and the queue would never empty.
    /// </summary>
    Task<int> ReclaimExpiredLeasesAsync(DateTimeOffset now, CancellationToken ct = default);

    /// <summary>For the heartbeat and the tray. Keep it cheap: called every 30 seconds.</summary>
    Task<OutboxDepth> GetDepthAsync(CancellationToken ct = default);

    /// <summary>
    /// Feed for <see cref="OutboxBudget"/>: each row's id, kind, age and size.
    /// The payload is not fetched (see the comment on <see cref="OutboxEntryInfo"/>).
    /// </summary>
    Task<IReadOnlyList<OutboxEntryInfo>> SurveyAsync(CancellationToken ct = default);

    /// <summary>
    /// Drops rows to fit the budget. Like <see cref="AckAsync"/>, it deletes the file too.
    /// Returns how many were really deleted.
    ///
    /// Never delete a leased row: it is being uploaded right now.
    /// </summary>
    Task<int> EvictAsync(IReadOnlyList<long> rowIds, string reason, CancellationToken ct = default);
}
