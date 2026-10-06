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
    public void প্রথমবার_স্টার্টআপ() =>
        Assert.Equal(
            OutboxSweep.Reason.Startup,
            OutboxSweep.Check(DateTimeOffset.MinValue, Now, Hourly, hasWriteError: false));

    [Fact]
    public void সদ্য_চললে_আবার_চলে_না() =>
        Assert.Equal(
            OutboxSweep.Reason.No,
            OutboxSweep.Check(Now.AddMinutes(-20), Now, Hourly, hasWriteError: false));

    [Fact]
    public void ঘণ্টা_পেরোলে_চলে() =>
        Assert.Equal(
            OutboxSweep.Reason.Due,
            OutboxSweep.Check(Now.AddMinutes(-61), Now, Hourly, hasWriteError: false));

    /// <summary>
    /// Careful: it must run exactly at the one-hour mark too. Writing `>` would make the
    /// sweep slip a tick later each time and run a few times fewer by the end of the day.
    /// </summary>
    [Fact]
    public void ঠিক_এক_ঘণ্টার_মাথায়ও_চলে() =>
        Assert.Equal(
            OutboxSweep.Reason.Due,
            OutboxSweep.Check(Now.AddHours(-1), Now, Hourly, hasWriteError: false));

    /// <summary>
    /// A failed write means the disk is full, which is exactly when room is needed.
    /// Waiting for the hour would silently lose the data in between.
    /// </summary>
    [Fact]
    public void লেখা_ব্যর্থ_হলে_অপেক্ষা_নেই() =>
        Assert.Equal(
            OutboxSweep.Reason.WriteFailed,
            OutboxSweep.Check(Now.AddSeconds(-5), Now, Hourly, hasWriteError: true));

    [Fact]
    public void লেখার_ব্যর্থতা_স্টার্টআপের_চেয়েও_আগে() =>
        Assert.Equal(
            OutboxSweep.Reason.WriteFailed,
            OutboxSweep.Check(DateTimeOffset.MinValue, Now, Hourly, hasWriteError: true));
}
