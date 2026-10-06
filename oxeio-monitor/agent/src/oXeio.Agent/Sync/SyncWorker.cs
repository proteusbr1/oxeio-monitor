using System.Runtime.Versioning;

using oXeio.Agent.Storage;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Sync;

/// <summary>
/// From the outbox to the server: this loop is what ties the modules together.
///
/// <b>The order matters:</b> segments come first. When the link is weak or the backlog is
/// large, whatever goes first should be the <b>payroll data</b>; screenshots (the biggest in
/// size, the least important) go last.
///
/// <b>Every cycle has limits:</b> if one kind of row ran indefinitely the others would
/// starve. Even with a 50,000-row backlog, segments and events both keep moving.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class SyncWorker(
    IOutboxStore store,
    ISyncClient client,
    ISyncLog? log = null,
    RetryPolicy? retry = null,
    SyncHealthPolicy? health = null,
    Func<DateTimeOffset>? clock = null)
{
    /// <summary>Most batches per kind in one cycle; prevents starvation.</summary>
    private const int MaxBatchesPerKindPerCycle = 4;

    /// <summary>
    /// How long a lease lasts. Comfortably longer than the maximum upload time (60 s), so that
    /// on a slow link our own lease does not expire and cause a double send.
    /// </summary>
    private static readonly TimeSpan LeaseFor = TimeSpan.FromMinutes(5);

    /// <summary>Segments first, screenshots last; deliberate.</summary>
    private static readonly OutboundKind[] Order =
    [
        OutboundKind.Segment,
        OutboundKind.Event,
        OutboundKind.AppUsage,
        OutboundKind.Screenshot,
    ];

    private readonly ISyncLog _log = log ?? NullSyncLog.Instance;
    private readonly RetryPolicy _retry = retry ?? RetryPolicy.Default;
    private readonly SyncHealthPolicy _health = health ?? SyncHealthPolicy.Default;
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    private readonly Dictionary<OutboundKind, BatchNarrowing> _narrowing = new()
    {
        [OutboundKind.Segment] = new BatchNarrowing(SyncLimits.MaxBatchSize),
        [OutboundKind.Event] = new BatchNarrowing(SyncLimits.MaxBatchSize),
        [OutboundKind.AppUsage] = new BatchNarrowing(SyncLimits.MaxBatchSize),

        // Screenshots go as multipart, one at a time; no question of splitting
        [OutboundKind.Screenshot] = new BatchNarrowing(1),
    };

    private readonly DateTimeOffset _startedAt = (clock ?? (() => DateTimeOffset.UtcNow))();

    public DateTimeOffset? LastSuccessAt { get; private set; }
    public bool Revoked { get; private set; }
    public OutboxDepth Depth { get; private set; }

    public SyncHealth Health =>
        _health.Evaluate(LastSuccessAt, _startedAt, Depth.Total, Revoked, _clock());

    public string? HealthDetail => SyncHealthPolicy.Describe(Health, Depth.Total);

    /// <summary>
    /// One drain attempt. Exceptions do not escape: if this loop died, data would never
    /// reach the server again and nobody would even see it.
    /// </summary>
    public async Task DrainOnceAsync(CancellationToken ct = default)
    {
        if (Revoked) return;

        try
        {
            // Reclaim leases stuck from a crash; otherwise those rows would stay invisible
            // until their lease expired
            var reclaimed = await store.ReclaimExpiredLeasesAsync(_clock(), ct);
            if (reclaimed > 0)
                _log.Warn($"{reclaimed} stuck leases were released (did the previous run crash?)");

            foreach (var kind in Order)
            {
                if (ct.IsCancellationRequested || Revoked) break;
                await DrainKindAsync(kind, ct);
            }

            Depth = await store.GetDepthAsync(ct);
        }
        catch (OperationCanceledException)
        {
            // Asked to stop; normal
        }
        catch (Exception ex)
        {
            _log.Error("Unexpected error in the sync cycle — it will be retried on the next cycle", ex);
        }
    }

    /// <summary>
    /// Drains just one <paramref name="kind"/> right now. At shutdown,
    /// <c>AgentHost.DisposeAsync</c> calls this before the full drain so that the farewell
    /// events (<see cref="OutboundKind.Event"/>) are not stuck behind the segment backlog.
    /// <see cref="DrainOnceAsync"/> always goes through every kind in <see cref="Order"/>;
    /// this does just one.
    ///
    /// Careful: like <see cref="DrainOnceAsync"/>, exceptions do not escape. This path runs
    /// in the last moments of shutdown, and an exception escaping there would bring the
    /// process down messily.
    /// </summary>
    public async Task DrainKindOnceAsync(OutboundKind kind, CancellationToken ct = default)
    {
        if (Revoked) return;

        try
        {
            await DrainKindAsync(kind, ct);
        }
        catch (OperationCanceledException)
        {
            // Asked to stop; normal
        }
        catch (Exception ex)
        {
            _log.Error(
                $"Unexpected error draining {kind} — it will be retried on the next cycle", ex);
        }
    }

    private async Task DrainKindAsync(OutboundKind kind, CancellationToken ct)
    {
        var narrowing = _narrowing[kind];

        for (var round = 0; round < MaxBatchesPerKindPerCycle; round++)
        {
            if (ct.IsCancellationRequested || Revoked) return;

            var now = _clock();
            var lease = await store.LeaseAsync(kind, narrowing.Current, LeaseFor, now, ct);
            if (lease is null || lease.Count == 0) return;

            var outcome = await SendLeaseAsync(kind, lease, ct);
            await ApplyOutcomeAsync(kind, lease, outcome, narrowing, ct);

            // On Permanent, the batch is narrowed and retried **immediately**, so the loop
            // continues. In every other case a smaller batch means there is nothing left.
            if (outcome.Outcome != SyncOutcome.Permanent && lease.Count < narrowing.Current) return;
        }
    }

    // ── sending ─────────────────────────────────────────────────────────────

    private async Task<SyncResult<object>> SendLeaseAsync(
        OutboundKind kind, OutboxLease lease, CancellationToken ct)
    {
        if (kind == OutboundKind.Screenshot) return await SendScreenshotAsync(lease, ct);

        var decoded = Decode(kind, lease, out var unreadable);

        if (unreadable > 0)
        {
            // Careful: we must not stay silent. A corrupt row means lost hours, and from the
            // server's side it would look normal.
            _log.Error($"{kind}: {unreadable} rows could not be read — dropping them");
        }

        if (decoded.Count == 0)
        {
            return SyncResult<object>.Permanent(null, "Not a single row could be read");
        }

        return kind switch
        {
            OutboundKind.Segment =>
                Erase(await client.SendSegmentsAsync(decoded.Cast<ActivitySegment>().ToList(), ct)),
            OutboundKind.Event =>
                Erase(await client.SendEventsAsync(decoded.Cast<AgentEventRecord>().ToList(), ct)),
            OutboundKind.AppUsage =>
                Erase(await client.SendAppUsageAsync(decoded.Cast<AppUsageRecord>().ToList(), ct)),
            _ => SyncResult<object>.Permanent(null, $"Unknown kind {kind}"),
        };
    }

    private async Task<SyncResult<object>> SendScreenshotAsync(
        OutboxLease lease, CancellationToken ct)
    {
        var entry = lease.Entries[0];
        var meta = OutboxCodec.Decode<ScreenshotRecord>(entry.Payload);

        if (meta is null)
            return SyncResult<object>.Permanent(null, "Could not read the screenshot metadata");

        if (string.IsNullOrWhiteSpace(entry.FilePath) || !File.Exists(entry.FilePath))
        {
            // The file itself is gone, so there is no point keeping the row. This happens if
            // the disk budget trims the image but the row remains.
            return SyncResult<object>.Permanent(null, "The screenshot file is not on disk");
        }

        return Erase(await client.SendScreenshotAsync(meta, entry.FilePath, ct));
    }

    private List<object> Decode(OutboundKind kind, OutboxLease lease, out int unreadable)
    {
        var list = new List<object>(lease.Count);
        unreadable = 0;

        foreach (var e in lease.Entries)
        {
            var record = OutboxCodec.Decode(kind, e.Payload);
            if (record is null) unreadable++;
            else list.Add(record);
        }

        return list;
    }

    private static SyncResult<object> Erase<T>(SyncResult<T> r) where T : class => new()
    {
        Outcome = r.Outcome,
        StatusCode = r.StatusCode,
        Detail = r.Detail,
        RetryAfter = r.RetryAfter,
    };

    // ── acting on the result ────────────────────────────────────────────────

    private async Task ApplyOutcomeAsync(
        OutboundKind kind,
        OutboxLease lease,
        SyncResult<object> result,
        BatchNarrowing narrowing,
        CancellationToken ct)
    {
        var now = _clock();

        switch (result.Outcome)
        {
            case SyncOutcome.Success:
                await store.AckAsync(lease.LeaseId, ct);
                narrowing.OnSuccess();
                LastSuccessAt = now;
                break;

            case SyncOutcome.Transient:
                narrowing.OnTransient();
                await RetryLaterAsync(lease, result, now, ct);
                break;

            // Splitting a batch makes sense **only when the server has ruled**, because only
            // then do we not know which of the 500 is the culprit. When we ourselves call
            // something bad (payload unreadable, image file missing), we already know which one
            // is bad, so splitting is just a waste of 8 cycles while the head of the queue
            // stays blocked.
            case SyncOutcome.Permanent when result.StatusCode is null:
            case SyncOutcome.Permanent when narrowing.IsIsolated:
                // Rejected even as a single record; the fault is certainly in this one
                await store.AbandonAsync(
                    lease.LeaseId,
                    result.Detail ?? $"The server rejected it (HTTP {result.StatusCode})",
                    ct);

                _log.Error(
                    $"{kind}: one record permanently dropped — {result.Detail ?? "reason unknown"} " +
                    $"(uuid {lease.Entries[0].ClientUuid})");

                narrowing.OnIsolatedDropped();
                break;

            case SyncOutcome.Permanent:
                // There is a bad record somewhere in the batch. We cannot throw the whole thing
                // away; halve it and try again until the culprit is alone.
                narrowing.OnPermanent();
                _log.Warn(
                    $"{kind}: a batch of {lease.Count} was rejected — " +
                    $"retrying with {narrowing.Current} (hunting for the bad record)");

                // Again immediately; nothing to wait for, it is not the server's fault
                await store.RetryAsync(lease.LeaseId, now, ct);
                break;

            case SyncOutcome.Revoked:
                Revoked = true;
                _log.Error("⛔ This device has been revoked by the server — sync stopped");

                // Careful: data is not deleted. A revoke can happen by mistake, and then the
                // only way to get the rows back is for them to have survived.
                await store.RetryAsync(lease.LeaseId, now.AddYears(1), ct);
                break;
        }
    }

    private async Task RetryLaterAsync(
        OutboxLease lease, SyncResult<object> result, DateTimeOffset now, CancellationToken ct)
    {
        var oldest = lease.Entries[0];

        if (_retry.ShouldAbandon(oldest.Attempts + 1, oldest.EnqueuedAt, now))
        {
            await store.AbandonAsync(lease.LeaseId, "older than 30 days — no longer useful", ct);
            _log.Warn($"{lease.Kind}: {lease.Count} rows dropped because of their age");
            return;
        }

        var next = _retry.NextAttemptAt(
            oldest.Attempts + 1, now, Random.Shared.NextDouble(), result.RetryAfter);

        await store.RetryAsync(lease.LeaseId, next, ct);
    }
}
