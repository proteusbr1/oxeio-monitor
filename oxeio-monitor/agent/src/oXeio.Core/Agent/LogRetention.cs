namespace oXeio.Core.Agent;

/// <summary>
/// H08: which of the agent's log files must be deleted.
///
/// The spec has two limits (<a href="../../../docs/04-Features.md">04 § H08</a>):
/// <b>7 days</b>, and <b>50 MB in total</b>. Both are needed because they guard against
/// different dangers: without the day limit, a quiet machine would collect logs for years,
/// and without the size limit a crash loop could fill the disk in one afternoon.
///
/// <b>Why the decision is in Core:</b> "which file do I delete" is the one part where a
/// mistake <b>destroys data</b>, and if it sat in the file-rotation code, verifying it would
/// need logs with seven-day-old timestamps. Here every branch can be covered by unit tests.
/// </summary>
public static class LogRetention
{
    /// <summary>04 § H08: "7 days".</summary>
    public const int DefaultKeepDays = 7;

    /// <summary>04 § H08: "max 50 MB".</summary>
    public const long DefaultMaxBytes = 50L * 1024 * 1024;

    /// <param name="Path">Full path; the caller passes exactly this to <c>File.Delete</c>.</param>
    /// <param name="Day">The day of the file (the date written in the name, not mtime).</param>
    public readonly record struct LogFile(string Path, DateOnly Day, long Bytes);

    /// <summary>
    /// Which <b>old</b> files go.
    ///
    /// <paramref name="archives"/> must <b>not contain today's current file</b>. The file being
    /// written right now never goes on the delete list, even if it alone exceeds the budget.
    /// Deleting it would lose the very latest writes, exactly when the log is needed most (the
    /// disk is filling up). Its size is counted in the budget as <paramref name="activeBytes"/>.
    /// </summary>
    public static IReadOnlyList<LogFile> Plan(
        IEnumerable<LogFile> archives,
        long activeBytes,
        DateOnly today,
        int keepDays = DefaultKeepDays,
        long maxBytes = DefaultMaxBytes)
    {
        // Oldest first: both steps need the same order
        var sorted = archives.OrderBy(f => f.Day).ToList();
        var doomed = new List<LogFile>();

        // ── Step 1: age ─────────────────────────────────────────────────────
        //
        // "Older than" `keepDays` days is counted including today. With keepDays = 7, today plus
        // the previous 6 days stay and the seventh day's file goes. Writing `<` would keep 8
        // days: one more than the spec, and nobody would notice.
        var cutoff = today.AddDays(-(keepDays - 1));
        var kept = new List<LogFile>();

        foreach (var file in sorted)
        {
            // Files dated in the future are kept too (possible if the clock went back);
            // deleting them would lose today's log because of one clock error.
            if (file.Day < cutoff) doomed.Add(file);
            else kept.Add(file);
        }

        // ── Step 2: size ────────────────────────────────────────────────────
        var total = activeBytes + kept.Sum(f => f.Bytes);

        foreach (var file in kept)
        {
            if (total <= maxBytes) break;

            doomed.Add(file);
            total -= file.Bytes;
        }

        // `total > maxBytes` can still hold after the loop: the active file alone is large.
        // Nothing more can be done then, and that is right: deleting today's log to meet the
        // budget would lose exactly the information the log exists for.
        return doomed;
    }
}
