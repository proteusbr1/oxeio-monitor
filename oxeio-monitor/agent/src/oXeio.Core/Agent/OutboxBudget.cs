namespace oXeio.Core.Agent;

/// <summary>
/// Result of <see cref="OutboxBudget.Plan"/>. The two lists are kept apart so the log can say
/// "dropped as too old" and "dropped for lack of space" separately; seeing the second means
/// the disk budget or the retention needs changing.
/// </summary>
public sealed record EvictionPlan
{
    /// <summary>Dropped by the age rule.</summary>
    public required IReadOnlyList<long> ExpiredRowIds { get; init; }

    /// <summary>Dropped for exceeding the disk cap.</summary>
    public required IReadOnlyList<long> OverBudgetRowIds { get; init; }

    /// <summary>Both combined: this is what goes to <see cref="IOutboxStore.EvictAsync"/>.</summary>
    public required IReadOnlyList<long> RowIds { get; init; }

    public required long BytesBefore { get; init; }
    public required long BytesFreed { get; init; }

    public long BytesAfter => BytesBefore - BytesFreed;

    public bool IsEmpty => RowIds.Count == 0;

    public static EvictionPlan Nothing(long bytesBefore) => new()
    {
        ExpiredRowIds = [],
        OverBudgetRowIds = [],
        RowIds = [],
        BytesBefore = bytesBefore,
        BytesFreed = 0,
    };
}

/// <summary>
/// What gets thrown away when the disk is full: pure policy, no I/O.
///
/// <b>The order is the whole point:</b> screenshot → app-usage → event → segment.
///
/// <code>
/// screenshots: ~200 KB x 288 slots x 3 monitors = ~170 MB per day   (99% of the volume)
/// segment    : ~200 bytes x a few hundred per day = ~100 KB per day (payroll)
/// </code>
///
/// So dropping one screenshot frees as much space as about a thousand segments. Dropping one
/// segment frees almost nothing, but someone's payroll hours are lost forever. So segments
/// go <b>last of all</b>, and in practice their turn never comes; that is the intended
/// design, not an accident.
///
/// Leased rows are never dropped: they are being uploaded right now, and pulling the file out
/// from under them would break the upload midway.
/// </summary>
public sealed record OutboxBudget
{
    public OutboxBudget(long capBytes, long targetBytes, TimeSpan maxAge, TimeSpan segmentMaxAge)
    {
        if (capBytes <= 0) throw new ArgumentOutOfRangeException(nameof(capBytes));
        if (targetBytes <= 0 || targetBytes > capBytes)
            throw new ArgumentOutOfRangeException(nameof(targetBytes));
        if (maxAge <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(maxAge));
        if (segmentMaxAge < maxAge) throw new ArgumentOutOfRangeException(nameof(segmentMaxAge));

        CapBytes = capBytes;
        TargetBytes = targetBytes;
        MaxAge = maxAge;
        SegmentMaxAge = segmentMaxAge;
    }

    /// <summary>Trimming starts once above this.</summary>
    public long CapBytes { get; }

    /// <summary>
    /// Trimming brings it down to this. Kept below the cap for hysteresis: stopping exactly at
    /// the cap would trigger another trim on every following screenshot.
    /// </summary>
    public long TargetBytes { get; }

    /// <summary>How long until screenshots / app-usage / events become useless.</summary>
    public TimeSpan MaxAge { get; }

    /// <summary>
    /// Segments get their own, much longer lifetime. Do not merge them: a two-week
    /// connectivity outage would wipe out a whole fortnight's pay.
    /// </summary>
    public TimeSpan SegmentMaxAge { get; }

    /// <summary>
    /// 2 GiB cap, 1.5 GiB target, 7 days, 30 days for segments.
    ///
    /// Why 2 GiB: ~170 MB per day x 7 days = ~1.2 GB, which covers the whole seven days of
    /// offline tolerance the docs promise, yet is not noticeable on an office PC's disk.
    /// </summary>
    public static OutboxBudget Default { get; } = new(
        capBytes: 2L * 1024 * 1024 * 1024,
        targetBytes: 1536L * 1024 * 1024,
        maxAge: TimeSpan.FromDays(7),
        segmentMaxAge: TimeSpan.FromDays(30));

    /// <summary>
    /// Screenshots first, segments last. This deliberately does not rely on the enum order of
    /// <see cref="OutboundKind"/>: moving one member there would silently start deleting
    /// payroll data first.
    /// </summary>
    public static int EvictionRank(OutboundKind kind) => kind switch
    {
        OutboundKind.Screenshot => 0,
        OutboundKind.AppUsage => 1,
        OutboundKind.Event => 2,
        OutboundKind.Segment => 3,
        _ => 3,
    };

    /// <param name="entries">
    /// A survey of the whole outbox (<see cref="IOutboxStore.SurveyAsync"/>). Passing only part
    /// of it undercounts total bytes and trims less.
    /// </param>
    public EvictionPlan Plan(IReadOnlyList<OutboxEntryInfo> entries, DateTimeOffset now)
    {
        var bytesBefore = 0L;
        foreach (var e in entries) bytesBefore += e.SizeBytes;

        if (entries.Count == 0) return EvictionPlan.Nothing(bytesBefore);

        var expired = new List<long>();
        var survivors = new List<OutboxEntryInfo>(entries.Count);
        var freed = 0L;

        foreach (var e in entries)
        {
            if (e.Leased)
            {
                survivors.Add(e);
                continue;
            }

            var limit = e.Kind == OutboundKind.Segment ? SegmentMaxAge : MaxAge;
            if (now - e.EnqueuedAt > limit)
            {
                expired.Add(e.RowId);
                freed += e.SizeBytes;
            }
            else
            {
                survivors.Add(e);
            }
        }

        var overBudget = new List<long>();
        var remaining = bytesBefore - freed;

        if (remaining > CapBytes)
        {
            // Leased rows are excluded, then "cheapest first, and within that oldest first"
            var candidates = survivors
                .Where(x => !x.Leased)
                .OrderBy(x => EvictionRank(x.Kind))
                .ThenBy(x => x.EnqueuedAt)
                .ThenBy(x => x.RowId);

            foreach (var e in candidates)
            {
                if (remaining <= TargetBytes) break;

                overBudget.Add(e.RowId);
                freed += e.SizeBytes;
                remaining -= e.SizeBytes;
            }
        }

        if (expired.Count == 0 && overBudget.Count == 0)
            return EvictionPlan.Nothing(bytesBefore);

        var all = new List<long>(expired.Count + overBudget.Count);
        all.AddRange(expired);
        all.AddRange(overBudget);

        return new EvictionPlan
        {
            ExpiredRowIds = expired,
            OverBudgetRowIds = overBudget,
            RowIds = all,
            BytesBefore = bytesBefore,
            BytesFreed = freed,
        };
    }
}
