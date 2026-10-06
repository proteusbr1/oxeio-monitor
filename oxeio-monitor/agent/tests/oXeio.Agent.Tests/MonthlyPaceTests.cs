using oXeio.Agent.Ui;

namespace oXeio.Agent.Tests;

/// <summary>
/// J04's "ahead or behind".
///
/// Careful: the number is approximate (the agent does not know the holiday list), but
/// the <b>direction</b> must never be wrong. Showing "ahead" for someone who is behind
/// would defeat the whole purpose of this window.
/// </summary>
public class MonthlyPaceTests
{
    /// <summary>A moment in Dhaka time.</summary>
    private static DateTimeOffset Dhaka(int year, int month, int day, int hour = 12) =>
        new(year, month, day, hour, 0, 0, TimeSpan.FromHours(6));

    // ── counting workdays ───────────────────────────────────────────────────

    /// <summary>August 2026 has 31 days, 4 of them Fridays (7, 14, 21, 28).</summary>
    [Fact]
    public void মাসের_কর্মদিবস_শুক্রবার_বাদে() =>
        Assert.Equal(31 - 4, MonthlyPace.WorkdaysInMonth(2026, 8));

    /// <summary>February 2028 is a leap year: 29 days, 4 Fridays (4, 11, 18, 25).</summary>
    [Fact]
    public void লিপ_বছরের_ফেব্রুয়ারিও_ঠিক_গোনা_হয() =>
        Assert.Equal(29 - 4, MonthlyPace.WorkdaysInMonth(2028, 2));

    /// <summary>
    /// Careful: today is counted too. Otherwise even on the last workday of the month
    /// the expected figure would be one day short of the target, and almost everyone
    /// would show a bogus "ahead".
    /// </summary>
    [Fact]
    public void আজকের_দিনও_গোনা_হয()
    {
        // 2026-08-03 is a Monday; none of 1, 2, 3 is a Friday
        Assert.Equal(3, MonthlyPace.WorkdaysElapsed(new DateOnly(2026, 8, 3)));

        // the 7th is a Friday, so it is excluded
        Assert.Equal(6, MonthlyPace.WorkdaysElapsed(new DateOnly(2026, 8, 7)));
    }

    // ── pace ────────────────────────────────────────────────────────────────

    /// <summary>
    /// On the last day of the month, expected lands exactly on the target (07 § 2.1-b).
    /// This is the formula's only hard anchor; if it breaks, everyone would show ahead
    /// or behind at month end, whatever the reason.
    /// </summary>
    [Fact]
    public void মাসের_শেষে_লক্ষ্য_ছুঁলে_গতি_শূন্য()
    {
        var pace = MonthlyPace.Estimate(
            TimeSpan.FromHours(208), 208, Dhaka(2026, 8, 31));

        Assert.NotNull(pace);
        Assert.Equal(0, pace!.Value.TotalHours, precision: 6);
    }

    [Fact]
    public void বেশি_কাজ_করলে_এগিয়ে()
    {
        var pace = MonthlyPace.Estimate(TimeSpan.FromHours(208), 208, Dhaka(2026, 8, 20));

        Assert.NotNull(pace);
        Assert.True(pace!.Value > TimeSpan.Zero);
    }

    [Fact]
    public void কম_কাজ_করলে_পিছিয়ে()
    {
        var pace = MonthlyPace.Estimate(TimeSpan.FromHours(10), 208, Dhaka(2026, 8, 20));

        Assert.NotNull(pace);
        Assert.True(pace!.Value < TimeSpan.Zero);
    }

    /// <summary>
    /// The Dhaka calendar, not UTC. 03:00 on the 1st in Dhaka is still 21:00 on the
    /// 31st of the previous month in UTC; with UTC the calculation would be for the
    /// previous month's last day, so the first morning of a new month would show
    /// "208 hours behind".
    /// </summary>
    [Fact]
    public void মাস_ঢাকার_ক্যালেন্ডারে_গোনা_হয()
    {
        var firstMorning = Dhaka(2026, 9, 1, hour: 3);

        var pace = MonthlyPace.Estimate(TimeSpan.Zero, 208, firstMorning);

        Assert.NotNull(pace);

        // 1 September = 1 workday elapsed out of 26, so
        // expected is about 8 hours. With last month's figures it would show 208 hours behind.
        Assert.InRange(-pace!.Value.TotalHours, 1, 20);
    }

    /// <summary>
    /// Careful: with a target of 0 the result is <c>null</c>, not 0. Returning 0 would
    /// put "0 hours ahead" in the window, so having no target would look like perfection.
    /// </summary>
    [Theory]
    [InlineData(0d)]
    [InlineData(-5d)]
    [InlineData(double.NaN)]
    public void লক্ষ্য_না_থাকলে_গতিও_নেই(double target) =>
        Assert.Null(MonthlyPace.Estimate(TimeSpan.FromHours(10), target, Dhaka(2026, 8, 10)));

    // ══════════════ G111: "not observed yet" comes first ══════════════

    /// <summary>
    /// <b>The order is the only claim of this section.</b>
    ///
    /// Careful: in this state the server sends <c>paceSec: 0</c>, so "0:00 ahead" would
    /// be shown: praise on a new staff member's first day with not one observation behind it.
    /// </summary>
    [Fact]
    public void না_দেখা_হলে_সার্ভারের_শূন্যও_নয়()
    {
        Assert.Equal(
            MonthlyPace.PaceView.NotObserved,
            MonthlyPace.ViewFor(false, TimeSpan.Zero, TimeSpan.FromHours(-3)));
    }

    /// <summary>
    /// <b>This is the most important test.</b>
    ///
    /// Careful: if the branch were placed <b>after</b> the estimate, <c>Estimated</c>
    /// would be returned here. The estimate counts from the 1st of the month, so it
    /// would report as a deficit exactly the unobserved days for which the server
    /// deliberately made no claim: fixing one false reassurance by creating the
    /// opposite false accusation.
    /// </summary>
    [Fact]
    public void না_দেখা_হলে_আন্দাজেও_ফেরা_যায_না()
    {
        Assert.Equal(
            MonthlyPace.PaceView.NotObserved,
            MonthlyPace.ViewFor(false, null, TimeSpan.FromHours(-94)));
    }

    /// <summary>Old server (no <c>observed</c>): behavior is exactly as before.</summary>
    [Fact]
    public void দেখা_হলে_সার্ভারের_সংখ্যাই()
    {
        Assert.Equal(
            MonthlyPace.PaceView.Server,
            MonthlyPace.ViewFor(true, TimeSpan.FromHours(-2), TimeSpan.FromHours(-9)));
    }

    /// <summary>
    /// The server is silent but the staff member was observed: only then use the estimate.
    /// </summary>
    [Fact]
    public void সার্ভার_না_বললে_আন্দাজ()
    {
        Assert.Equal(
            MonthlyPace.PaceView.Estimated,
            MonthlyPace.ViewFor(true, null, TimeSpan.FromHours(-9)));
    }

    /// <summary>
    /// No target at all: "0:00 hours ahead" is meaningless, so the line is dropped.
    /// </summary>
    [Fact]
    public void কোনো_সংখ্যাই_না_থাকলে_লাইন_বাদ()
    {
        Assert.Equal(MonthlyPace.PaceView.None, MonthlyPace.ViewFor(true, null, null));
    }
}
