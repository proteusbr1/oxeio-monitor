using oXeio.Core.Time;

namespace oXeio.Agent.Ui;

/// <summary>
/// "Ahead or behind": how many hours should have been done by this day of the month, and how
/// many have been done. Pure calculation: no I/O, no Win32, and the clock is passed in.
///
/// <code>
/// expected = target × (workdays elapsed / total workdays in the month)
/// pace     = worked − expected        // positive = ahead
/// </code>
///
/// <b>This is an estimate, and that must not be hidden.</b> In the spec (07 § 2.1-b) a
/// workday means a day that is outside both the weekly day off <b>and</b> the
/// <c>holidays</c> table. The agent does not know the holiday list; the server does not send
/// it. So the number here will differ from the dashboard's by an hour or two.
///
/// So there are two rules, both mandatory:
/// <list type="number">
/// <item>If the server sends <see cref="oXeio.Core.Agent.EmployeeProgress.PaceSec"/>,
///       <b>that</b> must be shown, not this calculation.</item>
/// <item>When this calculation is shown, the window must carry the word "estimated". Without
///       it, staff seeing two different numbers in two places would assume one is lying, and
///       the whole purpose of this window is to build trust.</item>
/// </list>
/// </summary>
internal static class MonthlyPace
{
    /// <summary>
    /// The weekly day off: <c>weekly_off_day: friday</c> from 07 § 2.1-b.
    ///
    /// Careful: the config (<see cref="oXeio.Core.Agent.AgentConfig"/>) has no such field, so
    /// it is set as a constant. If the office ever changes its day off, it has to be changed
    /// here too; otherwise the window will silently show a wrong "ahead/behind".
    /// </summary>
    public const DayOfWeek WeeklyOff = DayOfWeek.Friday;

    /// <summary>
    /// <paramref name="worked"/> = the time actually counted this month.
    /// Returns: positive means ahead, negative means behind.
    ///
    /// <c>null</c> if the target is 0 or negative: with "no target", being ahead or behind
    /// makes no sense, and showing 0 would be read as "exactly on target".
    /// </summary>
    public static TimeSpan? Estimate(TimeSpan worked, double targetHours, DateTimeOffset now)
    {
        if (targetHours <= 0 || double.IsNaN(targetHours) || double.IsInfinity(targetHours))
            return null;

        var today = DhakaTime.WorkDateOf(now);

        var total = WorkdaysInMonth(today.Year, today.Month);
        if (total <= 0) return null;

        var elapsed = WorkdaysElapsed(today);

        var expected = TimeSpan.FromHours(targetHours * elapsed / total);
        return worked - expected;
    }

    /// <summary>Total workdays in that month (excluding the weekly day off).</summary>
    public static int WorkdaysInMonth(int year, int month)
    {
        var days = DateTime.DaysInMonth(year, month);
        var count = 0;

        for (var day = 1; day <= days; day++)
        {
            if (new DateOnly(year, month, day).DayOfWeek != WeeklyOff) count++;
        }

        return count;
    }

    /// <summary>
    /// How many workdays have passed from the 1st of the month up to and <b>including</b> <paramref name="today"/>.
    ///
    /// Careful: today is counted even though the day is not over yet, so at nine in the
    /// morning everyone will show one day "behind". This is deliberate: when the target is met
    /// in the evening the number returns to zero, so on the last workday of the month expected
    /// lands exactly on the target (07 § 2.1-b). Excluding today would do the opposite: even at
    /// month end one day's work would look "extra", a false "ahead".
    /// </summary>
    public static int WorkdaysElapsed(DateOnly today)
    {
        var count = 0;

        for (var day = 1; day <= today.Day; day++)
        {
            if (new DateOnly(today.Year, today.Month, day).DayOfWeek != WeeklyOff) count++;
        }

        return count;
    }

    /// <summary>What to write about pace on the window's bottom line.</summary>
    internal enum PaceView
    {
        /// <summary>G111: the server said no finished workday has been observed yet.</summary>
        NotObserved,

        /// <summary>The number sent by the server: the same number as the dashboard's.</summary>
        Server,

        /// <summary>Our own guess; the label must say "(estimated)".</summary>
        Estimated,

        /// <summary>No target at all: pace means nothing, the line is omitted.</summary>
        None,
    }

    /// <summary>
    /// <b>Which statement is written, and in what order the decision is made.</b>
    ///
    /// Careful: <b>the order is the real substance here, which is why this is a pure
    /// function.</b> <see cref="PaceView.NotObserved"/> must be checked first. Checked later,
    /// <see cref="Estimate"/> would already have been chosen, and that estimate counts from
    /// the 1st of the month, so it would show exactly the unobserved days as a shortfall,
    /// days for which the server deliberately made no claim. Fixing one false reassurance
    /// ("0:00 ahead") would create a false accusation in the other direction.
    ///
    /// Careful: this could have stayed as an <c>if</c> ladder inside <see cref="TodayForm"/>,
    /// but then there would be <b>not a single assertion</b> on the order; WinForms drawing
    /// code cannot be reached from tests.
    /// </summary>
    /// <param name="paceObserved">
    /// <see cref="oXeio.Core.Agent.AgentStatus.PaceObserved"/>: <c>true</c> if the server did
    /// not say, so behavior with an old server is exactly as before.
    /// </param>
    /// <param name="serverPace">The server's number, or <c>null</c> if not sent.</param>
    /// <param name="estimate">Our estimate (<see cref="Estimate"/>), or <c>null</c>.</param>
    internal static PaceView ViewFor(
        bool paceObserved,
        TimeSpan? serverPace,
        TimeSpan? estimate)
    {
        // Careful: moving this branch below would silently bring G111 back
        if (!paceObserved) return PaceView.NotObserved;

        if (serverPace is not null) return PaceView.Server;
        if (estimate is not null) return PaceView.Estimated;

        return PaceView.None;
    }
}
