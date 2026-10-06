using System.Globalization;

using oXeio.Core.Agent;
using oXeio.Core.Time;

namespace oXeio.Agent.Ui;

/// <summary>
/// J03: once the month reaches 208 hours, say ✅ once. Only the pure decision is here; what
/// is remembered on disk is in <see cref="MilestoneMemory"/>.
///
/// <b>Exactly once a month: that is the whole reason for this file.</b> A heartbeat arrives
/// every 30-60 seconds, and once the target is reached the condition is true on every
/// heartbeat. Showing a balloon whenever the condition holds would raise sixty balloons an
/// hour for the rest of the month, with one consequence: staff would turn off oXeio's
/// notifications from Windows settings for good. Then the one urgent message we could show
/// when sync fails or the device is revoked is gone, and there is no way to restore it from
/// code.
///
/// Careful: the memory is on disk, not only in memory. The agent restarts at least once a
/// day (the PC is switched off), so an in-memory flag effectively means "once a day".
/// </summary>
internal static class MonthlyMilestone
{
    /// <summary>The balloon's class; the second safety net after <see cref="BalloonThrottle"/>.</summary>
    public const string EventClass = "monthly_target";

    /// <summary>
    /// The identity of the month in the Dhaka calendar, e.g. <c>2026-08</c>.
    ///
    /// Careful: not the UTC month. Dhaka is UTC+6, so at 2am on the 1st of the month UTC is
    /// still the previous month; in those six hours the new month's balloon would be recorded
    /// under the old month, and shown again when the new month started.
    /// </summary>
    public static string MonthKeyOf(DateTimeOffset now)
    {
        var date = WorkTime.WorkDateOf(now);
        return date.Year.ToString("0000", CultureInfo.InvariantCulture) + "-" +
               date.Month.ToString("00", CultureInfo.InvariantCulture);
    }

    /// <summary>Whether the target has been reached. Never, if the target is 0/abnormal.</summary>
    public static bool Reached(TimeSpan monthActive, double targetHours)
    {
        if (targetHours <= 0 || double.IsNaN(targetHours) || double.IsInfinity(targetHours))
            return false;

        return monthActive >= TimeSpan.FromHours(targetHours);
    }

    /// <summary>
    /// Whether a balloon should be shown right now.
    /// </summary>
    /// <param name="status">The tray's latest state.</param>
    /// <param name="now">Used to derive the Dhaka month.</param>
    /// <param name="lastCelebrated">The last month it was shown, or <c>null</c>.</param>
    /// <param name="monthKey">Current month key; if true is returned, record this.</param>
    public static bool ShouldCelebrate(
        AgentStatus status, DateTimeOffset now, string? lastCelebrated, out string monthKey)
    {
        monthKey = MonthKeyOf(now);

        if (status is null) return false;

        // Careful: already done once this month; the most important condition, so it goes first.
        if (string.Equals(lastCelebrated, monthKey, StringComparison.Ordinal)) return false;

        // Careful: if the server has never reported progress, the month slot is a false zero;
        // and if someone later put the agent's own count there (which starts from zero after
        // a reboot), without this condition the congratulation would come at the wrong time.
        if (!status.MonthlyKnown) return false;

        return Reached(status.ActiveThisMonth, status.MonthlyTargetHours);
    }

    /// <summary>
    /// The balloon text. Careful: no instruction, no request, only news. Writing something
    /// like "now take a rest" or "no more work needed" would become a policy instruction,
    /// yet 208 hours is a target, not a limit; the hours after it are fully counted too.
    /// </summary>
    public static string Text(double targetHours) =>
        $"✅ This month's {UiText.Hours(targetHours)} hours are complete";
}
