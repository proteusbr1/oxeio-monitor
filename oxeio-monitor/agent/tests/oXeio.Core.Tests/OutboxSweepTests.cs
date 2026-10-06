using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// A05: when the queue's disk budget is enforced.
///
/// Careful: the rule was **written** in the doc of `EnforceBudgetAsync` ("once at
/// startup, then once an hour, and whenever LastWriteError appears"), but the caller was
/// never written, so the whole budget mechanism was built and then sat idle. These tests
/// guard that rule.
/// </summary>
public class OutboxSweepTests
{
    private static readonly DateTimeOffset Now =
        new(2026, 8, 12, 12, 0, 0, TimeSpan.Zero);

    private static readonly TimeSpan Hourly = TimeSpan.FromHours(1);

    [Fact]
    public void The_first_run_is_the_startup_sweep() =>
        Assert.Equal(
            OutboxSweep.Reason.Startup,
            OutboxSweep.Check(DateTimeOffset.MinValue, Now, Hourly, hasWriteError: false));

    [Fact]
    public void A_recent_sweep_does_not_run_again() =>
        Assert.Equal(
            OutboxSweep.Reason.No,
            OutboxSweep.Check(Now.AddMinutes(-20), Now, Hourly, hasWriteError: false));

    [Fact]
    public void It_runs_once_the_hour_has_passed() =>
        Assert.Equal(
            OutboxSweep.Reason.Due,
            OutboxSweep.Check(Now.AddMinutes(-61), Now, Hourly, hasWriteError: false));

    /// <summary>
    /// Careful: it must run exactly at the one-hour mark too. Writing `>` would make the
    /// sweep slip a tick later each time and run a few times fewer by the end of the day.
    /// </summary>
    [Fact]
    public void It_runs_at_exactly_the_one_hour_mark_too() =>
        Assert.Equal(
            OutboxSweep.Reason.Due,
            OutboxSweep.Check(Now.AddHours(-1), Now, Hourly, hasWriteError: false));

    /// <summary>
    /// A failed write means the disk is full, which is exactly when room is needed.
    /// Waiting for the hour would silently lose the data in between.
    /// </summary>
    [Fact]
    public void A_failed_write_does_not_wait() =>
        Assert.Equal(
            OutboxSweep.Reason.WriteFailed,
            OutboxSweep.Check(Now.AddSeconds(-5), Now, Hourly, hasWriteError: true));

    [Fact]
    public void A_write_failure_takes_priority_over_startup() =>
        Assert.Equal(
            OutboxSweep.Reason.WriteFailed,
            OutboxSweep.Check(DateTimeOffset.MinValue, Now, Hourly, hasWriteError: true));
}
