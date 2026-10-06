using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// H08: the 7-day / 50 MB limit on log files.
///
/// Careful: every test here guards one question: <b>which file gets deleted</b>. A
/// mistake in this one place cannot be undone, and nobody notices until the day
/// someone looks in the log to chase a problem on some PC and finds nothing there.
/// </summary>
public class LogRetentionTests
{
    private static readonly DateOnly Today = new(2026, 8, 12);

    private static LogRetention.LogFile File(int daysAgo, long bytes = 1024) =>
        new($"agent-{Today.AddDays(-daysAgo):yyyy-MM-dd}.log", Today.AddDays(-daysAgo), bytes);

    private static IReadOnlyList<string> Plan(
        IEnumerable<LogRetention.LogFile> files,
        long activeBytes = 0,
        long maxBytes = LogRetention.DefaultMaxBytes) =>
        LogRetention.Plan(files, activeBytes, Today, maxBytes: maxBytes)
            .Select(f => f.Path)
            .ToList();

    [Fact]
    public void Nothing_is_deleted_when_there_are_no_files() =>
        Assert.Empty(Plan([]));

    [Fact]
    public void Files_up_to_six_days_old_are_kept() =>
        Assert.Empty(Plan([File(1), File(3), File(6)]));

    /// <summary>
    /// Careful: the boundary is here: keepDays = 7 means today plus the previous 6 days.
    /// The file from seven days ago is the seventh, so it goes. Writing `&lt;=` instead of
    /// `&lt;` would keep eight days.
    /// </summary>
    [Fact]
    public void Files_seven_days_old_or_more_are_deleted()
    {
        var doomed = Plan([File(6), File(7), File(30)]);

        Assert.Equal(2, doomed.Count);
        Assert.Contains("agent-2026-08-05.log", doomed);  // 7 days ago
        Assert.Contains("agent-2026-07-13.log", doomed);  // 30 days ago
    }

    /// <summary>
    /// Careful: if the clock goes back (an NTP correction, a dead BIOS battery), files
    /// dated in the future can remain. Deleting them would lose today's log because of a
    /// clock error, exactly when the log is most needed.
    /// </summary>
    [Fact]
    public void Files_dated_in_the_future_are_kept() =>
        Assert.Empty(Plan([new LogRetention.LogFile("tomorrow.log", Today.AddDays(1), 10)]));

    [Fact]
    public void Over_budget_the_oldest_file_goes_first()
    {
        // three files x 40 bytes = 120, budget 100, so deleting one is enough
        var doomed = Plan(
            [File(1, 40), File(2, 40), File(3, 40)],
            maxBytes: 100);

        Assert.Single(doomed);
        // the oldest one: the newer log is more useful
        Assert.Equal("agent-2026-08-09.log", doomed[0]);
    }

    /// <summary>
    /// The current file **counts** toward the budget, even though it never lands on
    /// the delete list itself. If it were not counted, today's 49 MB log would sit
    /// beside another 50 MB of archives, effectively doubling the limit.
    /// </summary>
    [Fact]
    public void The_active_file_counts_toward_the_budget()
    {
        var doomed = Plan([File(1, 40)], activeBytes: 80, maxBytes: 100);

        Assert.Single(doomed);
    }

    /// <summary>
    /// Careful: if the current file alone exceeds the budget there is nothing more to
    /// do: all archives go, but today's stays. Deleting it to meet the budget would lose
    /// exactly the information the log exists to keep.
    /// </summary>
    [Fact]
    public void When_the_active_file_alone_is_too_big_all_archives_go()
    {
        var doomed = Plan([File(1, 10), File(2, 10)], activeBytes: 500, maxBytes: 100);

        Assert.Equal(2, doomed.Count);
    }

    /// <summary>
    /// If the same file appeared on the list twice across two steps, the caller would call
    /// Delete twice.
    /// </summary>
    [Fact]
    public void A_file_matching_both_age_and_size_rules_is_listed_once()
    {
        var doomed = Plan([File(30, 400)], maxBytes: 100);

        Assert.Single(doomed);
    }
}
