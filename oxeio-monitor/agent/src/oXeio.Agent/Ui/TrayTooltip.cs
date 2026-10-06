using System.Text;

using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Ui;

/// <summary>
/// <see cref="AgentStatus"/> to tray tooltip text. Pure function, no Win32.
///
/// Important: <b>63-character limit.</b> The shell's <c>NOTIFYICONDATA.szTip</c> has 64 slots
/// in the old struct size (the last is NUL), and the <c>NotifyIcon.Text</c> setter still
/// throws <c>ArgumentOutOfRangeException</c> for anything over 63 characters, even on .NET 8.
/// An exception thrown on the UI thread would take the whole agent down, and the cause
/// would be "the text was a bit long".
///
/// In English one character is one UTF-16 unit, so more fits in 63 slots than in scripts
/// written with combining marks.
/// Even so, three lines do not always fit (the longest combination is about 80), so the lines
/// are ordered by priority: only as many as fit are shown, from the top.
/// </summary>
internal static class TrayTooltip
{
    public const int MaxLength = 63;

    /// <summary>
    /// The exact sentence promised in the spec. Careful: do not remove the "data is saved
    /// locally" part. It is the only explanation staff get for the red icon, and without
    /// saying that data is still being kept, everyone seeing red assumes their hours are lost.
    /// </summary>
    public const string SyncFailingLine = "Can't reach server, data saved locally";

    public const string RevokedLine = "Tracking is stopped on this device";

    /// <summary>
    /// Careful: do not remove the words "not counting". Plain "Not signed in" sounds like
    /// harmless information; the real news is that <b>hours are not being counted right now</b>.
    /// </summary>
    public const string NotEnrolledLine = "Not signed in — not counting hours";

    public static string StateName(SegmentState state) => state switch
    {
        SegmentState.Active => "Working",
        SegmentState.Locked => "Locked",
        _ => "Idle",
    };

    public static string Build(AgentStatus status) => Build(status, MaxLength);

    public static string Build(AgentStatus status, int maxLength)
    {
        if (status is null) return "oXeio";

        var lines = Lines(status);
        var text = Fit(lines, maxLength);

        // Never leave the tooltip empty: an empty szTip shows nothing on hover,
        // which leaves the icon unexplained.
        return string.IsNullOrEmpty(text) ? "oXeio" : text;
    }

    /// <summary>In priority order; the top line is the most important.</summary>
    private static List<string> Lines(AgentStatus status)
    {
        var lines = new List<string>(3);

        // Must come **before** Health. When not signed in the outbox is empty, so
        // `SyncHealthPolicy` reports healthy (`Ok`), and the tooltip would read
        // "Working · 0:00 today". The very reason nothing is happening would be the one
        // thing left invisible.
        //
        // The order is not hand-written here; it comes from `TrackingGate`. Writing it by
        // hand caused a bug: checking `!Enrolled` first showed "Not signed in" on **revoked**
        // devices too (revoking deletes the token, so both conditions are true). A test
        // caught it, and that is the whole reason for the gate.
        switch (TrackingGate.Check(status.Enrolled, status.Health is SyncHealth.Revoked))
        {
            case TrackingGate.Verdict.Revoked:
                lines.Add(RevokedLine);
                lines.Add("Contact your administrator");
                return lines;

            case TrackingGate.Verdict.NotEnrolled:
                lines.Add(NotEnrolledLine);
                lines.Add("Open oXeio from the tray to sign in");
                return lines;

            default: break;
        }

        switch (status.Health)
        {
            case SyncHealth.Failing:
                // The day's hours are left out on purpose. Both do not fit in 63 slots, and
                // the urgent news right now is "no data was lost"; the hours are fully shown
                // in the "Today's hours" window.
                lines.Add(SyncFailingLine);
                lines.Add($"{UiText.Number(Math.Max(0, status.QueueDepth))} queued");
                break;

            default:
                lines.Add(HeadLine(status));
                lines.Add(MonthLine(status));
                lines.Add(SyncLine(status));
                break;
        }

        return lines;
    }

    private static string HeadLine(AgentStatus status)
    {
        // Paused comes from a server command, not a staff button. Even so it must not be
        // hidden, or the reason hours are not growing stays invisible.
        var head = status.Paused ? "Tracking paused" : StateName(status.State);
        return $"{head} · Today {UiText.Duration(status.ActiveToday)}";
    }

    private static string MonthLine(AgentStatus status)
    {
        // The server has not reported the month total yet. Writing "0:00/208 (0%)" would
        // read as "you did nothing" when we simply do not know (AgentStatus.MonthlyKnown).
        if (!status.MonthlyKnown) return "Monthly total loading…";
        if (status.NoTarget) return $"Month {UiText.Duration(status.ActiveThisMonth)}";

        // "Month", not "This month". The sync line follows this one, and all three lines
        // must fit in 63 slots; five extra characters would push the sync line out.
        return $"Month {UiText.Duration(status.ActiveThisMonth)}/{UiText.Hours(status.MonthlyTargetHours)} " +
               $"({UiText.Percent(status.MonthlyProgress)})";
    }

    private static string SyncLine(AgentStatus status)
    {
        if (status.Health == SyncHealth.Degraded)
        {
            // Degraded does not turn the icon red (see the AgentStatus docs); it only hints
            // in the tooltip. Flipping between red and green makes staff stop looking at
            // the color.
            //
            // With the month line, all three do not fit in 63 slots, so in Degraded this
            // line is often dropped. That is accepted: Degraded is not urgent (Failing has
            // its own branch), and the full sync state is always in the "Today's hours" window.
            return $"Sync late · {UiText.Number(Math.Max(0, status.QueueDepth))} queued";
        }

        return status.LastSyncAt is { } at
            ? $"Sync {UiText.Clock(at)}"
            : "Not synced yet";
    }

    private static string Fit(List<string> lines, int maxLength)
    {
        var sb = new StringBuilder();

        foreach (var line in lines)
        {
            if (string.IsNullOrEmpty(line)) continue;

            var needed = sb.Length == 0 ? line.Length : line.Length + 1; // +1 = '\n'
            if (sb.Length + needed > maxLength)
            {
                // If even the first line does not fit, truncate it: better than an empty tooltip.
                if (sb.Length == 0) sb.Append(UiText.Truncate(line, maxLength));

                // break, not continue. The list is in priority order; skipping the second line
                // to fit the third would show staff less important information and make them
                // think the more important event did not happen.
                break;
            }

            if (sb.Length > 0) sb.Append('\n');
            sb.Append(line);
        }

        return sb.ToString();
    }
}
