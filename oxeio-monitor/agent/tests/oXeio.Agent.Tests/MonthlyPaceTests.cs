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
    /// <summary>A moment in the default work zone (Dhaka, UTC+6).</summary>
    private static DateTimeOffset AtWorkZone(int year, int month, int day, int hour = 12) =>
        new(year, month, day, hour, 0, 0, TimeSpan.FromHours(6));

    // ── counting workdays ───────────────────────────────────────────────────

    /// <summary>August 2026 has 31 days, 4 of them Fridays (7, 14, 21, 28).</summary>
    [Fact]
    public void Workdays_in_a_month_exclude_Fridays() =>
        Assert.Equal(31 - 4, MonthlyPace.WorkdaysInMonth(2026, 8));

    /// <summary>February 2028 is a leap year: 29 days, 4 Fridays (4, 11, 18, 25).</summary>
    [Fact]
    public void A_leap_year_February_is_counted_correctly() =>
        Assert.Equal(29 - 4, MonthlyPace.WorkdaysInMonth(2028, 2));

    /// <summary>
    /// Careful: today is counted too. Otherwise even on the last workday of the month
    /// the expected figure would be one day short of the target, and almost everyone
    /// would show a bogus "ahead".
    /// </summary>
    [Fact]
    public void Today_is_counted_too()
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
    public void Reaching_the_target_at_month_end_gives_zero_pace()
    {
        var pace = MonthlyPace.Estimate(
            TimeSpan.FromHours(208), 208, AtWorkZone(2026, 8, 31));

        Assert.NotNull(pace);
        Assert.Equal(0, pace!.Value.TotalHours, precision: 6);
    }

    [Fact]
    public void Working_more_than_expected_is_ahead()
    {
        var pace = MonthlyPace.Estimate(TimeSpan.FromHours(208), 208, AtWorkZone(2026, 8, 20));

        Assert.NotNull(pace);
        Assert.True(pace!.Value > TimeSpan.Zero);
    }

    [Fact]
    public void Working_less_than_expected_is_behind()
    {
        var pace = MonthlyPace.Estimate(TimeSpan.FromHours(10), 208, AtWorkZone(2026, 8, 20));

        Assert.NotNull(pace);
        Assert.True(pace!.Value < TimeSpan.Zero);
    }

    /// <summary>
    /// The work zone's calendar, not UTC. 03:00 on the 1st in Dhaka (UTC+6) is still 21:00 on the
    /// 31st of the previous month in UTC; with UTC the calculation would be for the
    /// previous month's last day, so the first morning of a new month would show
    /// "208 hours behind".
    /// </summary>
    [Fact]
    public void The_month_is_counted_in_the_work_zone_calendar()
    {
        var firstMorning = AtWorkZone(2026, 9, 1, hour: 3);

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
    public void No_target_means_no_pace(double target) =>
        Assert.Null(MonthlyPace.Estimate(TimeSpan.FromHours(10), target, AtWorkZone(2026, 8, 10)));

    // ══════════════ G111: "not observed yet" comes first ══════════════

    /// <summary>
    /// <b>The order is the only claim of this section.</b>
    ///
    /// Careful: in this state the server sends <c>paceSec: 0</c>, so "0:00 ahead" would
    /// be shown: praise on a new staff member's first day with not one observation behind it.
    /// </summary>
    [Fact]
    public void Not_observed_wins_even_over_a_server_zero()
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
    public void Not_observed_wins_even_over_the_estimate()
    {
        Assert.Equal(
            MonthlyPace.PaceView.NotObserved,
            MonthlyPace.ViewFor(false, null, TimeSpan.FromHours(-94)));
    }

    /// <summary>Old server (no <c>observed</c>): behavior is exactly as before.</summary>
    [Fact]
    public void When_observed_the_server_number_is_used()
    {
        Assert.Equal(
            MonthlyPace.PaceView.Server,
            MonthlyPace.ViewFor(true, TimeSpan.FromHours(-2), TimeSpan.FromHours(-9)));
    }

    /// <summary>
    /// The server is silent but the staff member was observed: only then use the estimate.
    /// </summary>
    [Fact]
    public void When_the_server_is_silent_the_estimate_is_used()
    {
        Assert.Equal(
            MonthlyPace.PaceView.Estimated,
            MonthlyPace.ViewFor(true, null, TimeSpan.FromHours(-9)));
    }

    /// <summary>
    /// No target at all: "0:00 hours ahead" is meaningless, so the line is dropped.
    /// </summary>
    [Fact]
    public void With_no_number_at_all_the_line_is_dropped()
    {
        Assert.Equal(MonthlyPace.PaceView.None, MonthlyPace.ViewFor(true, null, null));
    }
}
