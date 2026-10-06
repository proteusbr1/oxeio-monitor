namespace oXeio.Core.Agent;

/// <summary>
/// A row prepared for insertion into the outbox (no row id yet).
///
/// <see cref="Payload"/> is deliberately a <b>string</b>, not a typed object. The outbox is
/// not told what is inside; the sync worker deserializes it itself based on
/// <see cref="Kind"/>. So adding a new endpoint does not mean touching the store's code or
/// schema.
///
/// Serialization must stay <b>forward-compatible</b>. After an update the new agent reads rows
/// written by the old one; on a machine that was offline those rows can be several days old.
/// Renaming a field means losing that data forever. So only <i>add</i> new fields; never
/// rename or remove one.
/// </summary>
public sealed record OutboxItem
{
    /// <summary>The server's dedup key. Also stored in the row, so it is unchanged on retry.</summary>
    public required Guid ClientUuid { get; init; }

    public required OutboundKind Kind { get; init; }

    /// <summary>When the record was <b>created</b>, not when an upload was tried. Age is measured from this.</summary>
    public required DateTimeOffset EnqueuedAt { get; init; }

    /// <summary>The record's JSON. For a screenshot, the JSON of <see cref="ScreenshotRecord"/>.</summary>
    public required string Payload { get; init; }

    /// <summary>
    /// Only for <see cref="OutboundKind.Screenshot"/>: the full path of the .webp file.
    /// Null for everything else.
    /// </summary>
    public string? FilePath { get; init; }

    /// <summary>
    /// Roughly how much disk this row takes (payload + file). <see cref="OutboxBudget"/> sums
    /// this number. An estimate is acceptable, but for screenshots the file's real size must be
    /// set, otherwise the cap is meaningless.
    /// </summary>
    public required long SizeBytes { get; init; }
}

/// <summary>
/// A row returned from the outbox: <see cref="OutboxItem"/> plus the store's own bookkeeping.
/// </summary>
public sealed record OutboxEntry
{
    /// <summary>The store's internal id (SQLite rowid). ack/evict work from this.</summary>
    public required long RowId { get; init; }

    public required Guid ClientUuid { get; init; }
    public required OutboundKind Kind { get; init; }
    public required DateTimeOffset EnqueuedAt { get; init; }
    public required string Payload { get; init; }
    public string? FilePath { get; init; }
    public required long SizeBytes { get; init; }

    /// <summary>
    /// How many uploads have failed so far. 0 = never tried.
    /// This is what goes to <see cref="RetryPolicy"/> as <c>attempt</c>.
    /// </summary>
    public required int Attempts { get; init; }
}

/// <summary>
/// A light version for budget calculation: without <see cref="OutboxEntry.Payload"/>.
///
/// Why a separate type: a machine that was offline for a week can accumulate around a hundred
/// thousand rows. Loading every JSON string into RAM to fit the budget would kill the process
/// with OOM during the trim itself, causing exactly the problem it was meant to prevent.
/// </summary>
public readonly record struct OutboxEntryInfo(
    long RowId,
    OutboundKind Kind,
    DateTimeOffset EnqueuedAt,
    long SizeBytes,
    bool Leased);

/// <summary>
/// A batch of rows leased for upload.
///
/// If <see cref="IOutboxStore.AckAsync"/>, <see cref="IOutboxStore.RetryAsync"/> or
/// <see cref="IOutboxStore.AbandonAsync"/> is not called before the lease expires, the rows
/// become pending again by themselves.
/// </summary>
public sealed record OutboxLease
{
    /// <summary>The id of this lease. ack/retry/abandon all use it.</summary>
    public required Guid LeaseId { get; init; }

    /// <summary>A batch holds rows of one kind only: one endpoint, one request.</summary>
    public required OutboundKind Kind { get; init; }

    public required IReadOnlyList<OutboxEntry> Entries { get; init; }

    /// <summary>After this, <see cref="IOutboxStore.ReclaimExpiredLeasesAsync"/> takes the rows back.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    public int Count => Entries.Count;
}

/// <summary>
/// What is sitting in the queue: goes into the heartbeat's <c>queueDepth</c> and the tray tooltip.
/// </summary>
public readonly record struct OutboxDepth(
    int Segments,
    int AppUsage,
    int Events,
    int Screenshots,
    long BytesTotal)
{
    public int Total => Segments + AppUsage + Events + Screenshots;

    /// <summary>
    /// Goes in the heartbeat. The server does not accept negatives, and even when the queue is
    /// empty sending 0 is better: with null the dashboard could not tell "unknown" from
    /// "everything has been sent".
    /// </summary>
    public int ForHeartbeat => Total;

    public static OutboxDepth Empty => default;
}
