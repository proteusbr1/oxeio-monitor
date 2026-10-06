using System.Drawing;
using System.Runtime.Versioning;

using oXeio.Core.Agent;
using oXeio.Core.Models;
using oXeio.Core.Time;

namespace oXeio.Agent.Ui;

/// <summary>
/// "Today's hours": staff can see their own tally themselves.
///
/// This window is what keeps the system honest: the number their pay is calculated from is
/// always visible on their own screen, without having to ask an administrator.
///
/// Careful: there are no buttons here: no break, no meeting, no "claim time". Adding any one
/// of them would become the first step of an approval workflow, and this system has no
/// approval.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TodayForm : OwnerDrawnForm
{
    /// <summary>Last 30 minutes = 6 cells of 5 minutes (same as <c>AgentHost.BusyBlocks</c>).</summary>
    private const int BusyBlockCount = 6;

    /// <summary>Thumbnail width at 96 DPI. The window's inner width is 368px.</summary>
    private const int ThumbWidth = 220;

    private readonly Func<TrayOptions> _options;
    private AgentStatus _status = AgentStatus.Starting;

    /// <summary>
    /// <b>The seconds clock</b>: while the window is open, redrawn once a second.
    ///
    /// Careful: without this, showing seconds made no sense: <see cref="Apply"/> only draws
    /// <b>when the status changes</b>, and the status changes on a heartbeat or when a segment
    /// closes, not even once a minute. The owner saw exactly that: the digits had seconds but
    /// they did not move.
    ///
    /// Careful: when the window is closed the timer is off too, so an agent sitting in the
    /// tray draws nothing every second for no reason.
    /// </summary>
    private readonly System.Windows.Forms.Timer _tick = new() { Interval = 1_000 };

    /// <summary>The counted figure plus the time elapsed since (the rule lives in Core, with tests).</summary>
    private readonly LiveDuration _live = new();

    /// <summary>
    /// Careful: height 500 → 400. The new layout has less text, so at 500 a large empty dark
    /// band was left at the bottom, which looked like something was still loading.
    /// <see cref="OwnerDrawnForm"/> lengthens itself when needed (more text in the loading and
    /// alert states), so keeping it small is the safe side.
    /// </summary>
    public TodayForm(TrayFonts fonts, Func<TrayOptions> options)
        : base(fonts, "oXeio — Today's hours", 400, 400)
    {
        _options = options;

        // Careful: only Invalidate; the calculation happens in PaintBody, so the timer holds no
        // state. Repainting is cheap: the thumbnail is cached (OwnerDrawnForm.ThumbnailFor), so
        // there is no disk read every second.
        _tick.Tick += (_, _) => { if (Visible && !IsDisposed) Invalidate(); };
        _tick.Start();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _tick.Dispose();
        base.Dispose(disposing);
    }

    /// <summary>
    /// A new status. Careful: may only be called from the UI thread; <see cref="TrayIcon"/>
    /// already guarantees that when it calls.
    /// </summary>
    public void Apply(AgentStatus status)
    {
        if (status is null) return;

        // The record's value equality: if the same value arrives there is no need to redraw.
        // Leaving the window open would otherwise cause a pointless repaint every second.
        if (_status == status) return;

        _status = status;

        if (IsDisposed || !IsHandleCreated) return;
        Invalidate();
    }

    protected override void PaintBody(TextStack stack)
    {
        var status = _status;
        var options = _options();
        var now = DateTimeOffset.UtcNow;

        var who = string.IsNullOrWhiteSpace(options.EmployeeName)
            ? "This device"
            : options.EmpCode is { Length: > 0 } code
                ? $"{options.EmployeeName} ({code})"
                : options.EmployeeName!;

        stack.Line(who, TrayFontRole.Small, Theme.Ink2);
        stack.Line(UiText.WorkDate(now) + " · " + WorkTime.Label, TrayFontRole.Small, Muted);
        stack.Gap(6);

        // The state sits next to the number: it is the only thing in the window that changes
        // minute by minute.
        //
        // Careful: when not signed in, **"Working" must not be written**. That is exactly what
        // used to happen: a green dot and "Working", while nothing was being counted and
        // nothing was going to the server. Staff saw everything fine, so signing in never
        // occurred to them, and at the end of the day their hours were zero.
        // The hero number is the only one with seconds (the owner's request, 18 August);
        // the target bars below stay H:MM.
        //
        // And here is the **running** value: `status.ActiveToday` itself jumps up (on a
        // heartbeat or when a segment closes), so we add "how long work has been running
        // since" to it before showing; otherwise the digits would have seconds but not move.
        // The rule is in LiveDuration, with tests.
        var (figure, seconds) = UiText.SplitSeconds(
            UiText.DurationLong(
                _live.Next(status.ActiveToday, status.CountedAt, now, IsCounting(status))));

        // The seconds are at half size (the owner's request, 18 August): they are the only digit
        // that moves every second, and at full size they would hold the eye.
        stack.Hero(figure, seconds, "hours today", HeroState(status), StateDot(status));

        stack.Line(
            status.Enrolled
                ? "Counted so far — idle time already removed"
                : TrackingGate.Explain(TrackingGate.Verdict.NotEnrolled),
            TrayFontRole.Small,
            // Careful: Brand (red), not Idle (amber). In this window amber already means
            // "paused/behind", a temporary state. Not being signed in means **nothing is being
            // counted**, stuck just like a revoke, and that has always been red here.
            status.Enrolled ? Muted : Theme.Brand);

        stack.Rule();

        PaintTargets(stack, status, now);

        stack.Rule();

        PaintBusy(stack, status);

        stack.Rule();

        PaintLatestShot(stack, status);

        stack.Rule();

        // Careful: the sync state is always shown, not only when something is wrong. Before,
        // nothing here meant "assume fine", so the most important reassurance (the data
        // arrived) was invisible exactly when it was true.
        var bad = status.Health is SyncHealth.Failing or SyncHealth.Revoked;

        stack.Readout(
        [
            ("Sync", HealthName(status.Health), bad ? Theme.Brand : null),
            ("Last sync", status.LastSyncAt is { } at ? UiText.Clock(at) : "Not yet", null),
            ("Queued", UiText.Number(Math.Max(0, status.QueueDepth)), null),
        ]);

        // The full sentence appears only when something is really wrong; that is when a human
        // sentence is needed, not a label.
        if (status.Health is SyncHealth.Failing or SyncHealth.Revoked)
        {
            stack.Alert(status.HealthDetail is { Length: > 0 } detail
                ? detail
                : DefaultDetail(status.Health));
        }
        else if (status.Health is SyncHealth.Degraded)
        {
            stack.Gap(2);
            stack.Line(
                status.HealthDetail is { Length: > 0 } slow ? slow : DefaultDetail(status.Health),
                TrayFontRole.Small, Muted);
        }

        stack.Rule();

        // Careful: these two lines are not mere decoration. If the answer to "where did the
        // time go" is not given in advance, staff assume the system is eating their hours.
        stack.Line(
            $"Counting stops after {UiText.Number(options.EffectiveConfig.IdleThresholdSec)} seconds " +
            "without mouse or keyboard, and that idle time is removed from the total.",
            TrayFontRole.Small, Muted);

        stack.Line(
            "Nothing is lost without internet — it waits in the queue and is sent " +
            "automatically once the connection is back.",
            TrayFontRole.Small, Muted);
    }

    /// <summary>
    /// Month progress: <b>only after the server has given its number</b>.
    ///
    /// Careful: the agent does not keep the month's tally itself, so before the first heartbeat
    /// arrives <see cref="AgentStatus.ActiveThisMonth"/> is a false zero. Drawing the bar and
    /// percentage in that state would make staff see "0 / 208 hours · 0%" for a few seconds
    /// after every login, as if the month's work had vanished.
    /// So there are three states: unknown / known / no target.
    /// </summary>
    /// <summary>
    /// Three targets: today · last 7 days · this month. All three are bars of the same shape.
    ///
    /// The order is small to large: people first want to know "how did today go", then "the
    /// week", then "the month". Reversed, the most distant number would catch the eye first,
    /// yet there is nothing to do about it in today's work.
    ///
    /// Careful: <b>the only contract is the monthly 208 hours</b> (§ 4 · O8). The today and
    /// 7-day targets are display only; they have no relation to pay or deductions.
    /// </summary>
    private void PaintTargets(TextStack stack, AgentStatus status, DateTimeOffset now)
    {
        if (!status.MonthlyKnown)
        {
            stack.Pair("This month", "Loading…", TrayFontRole.Strong);
            stack.Gap(2);
            stack.Line(
                "The monthly total comes from the server — every PC added together. " +
                "It appears here as soon as the connection is made.",
                TrayFontRole.Small, Muted);
            return;
        }

        // ── today ─────────────────────────────────────────────────────────
        // Careful: a target of zero means a day off: a sentence, not a bar. Showing an empty
        // bar on a day off would nag "still 8 hours to go today".
        if (status.DailyTarget is { } daily && daily == TimeSpan.Zero)
        {
            stack.TargetRow(
                "Today", UiText.Duration(status.ActiveToday), null, Theme.Ink,
                note: "Day off — anything you do today still counts toward the month.");
        }
        else
        {
            stack.TargetRow(
                "Today",
                status.DailyTarget is { } t
                    ? $"{UiText.Duration(status.ActiveToday)} / {UiText.Duration(t)}"
                    : UiText.Duration(status.ActiveToday),
                status.DailyProgress,
                ProgressFill);
        }

        stack.Gap(6);

        // ── last 7 days ───────────────────────────────────────────────────
        stack.TargetRow(
            "Last 7 days",
            status.ActiveLast7 is { } worked && status.Last7Target is { } target
                ? $"{UiText.Duration(worked)} / {UiText.Duration(target)}"
                : "—",
            status.Last7Progress,
            ProgressFill);

        stack.Gap(6);

        // ── this month ────────────────────────────────────────────────────
        var pace = PaceOf(status, now);

        stack.TargetRow(
            "This month",
            $"{UiText.Duration(status.ActiveThisMonth)} / " +
            $"{UiText.Number((int)Math.Round(status.MonthlyTargetHours))} hours",
            status.MonthlyProgress,
            ProgressFill,
            expected: ExpectedRatio(status, pace));

        PaintLegend(stack, status, pace);
    }

    /// <summary>
    /// "How much the hands moved in each 5 minutes": the owner's request, but <b>not how many times</b>.
    ///
    /// Careful: how many times the keyboard was pressed is something this system cannot know,
    /// and will not try to: that would need a low-level hook, which is keylogging (04-Features
    /// § L) and explicitly rejected in G46. What can be seen here is <b>what percentage of the
    /// time</b> the hands moved; the number is each segment's <c>input_score</c>, which was
    /// already going to the server.
    /// </summary>
    private void PaintBusy(TextStack stack, AgentStatus status)
    {
        stack.Pair("Keyboard & mouse", "last 30 min", TrayFontRole.Body);
        stack.Gap(4);

        stack.BusyBlocks(status.RecentBusy, BusyBlockCount);

        stack.Line(
            status.RecentBusy.Count == 0
                ? "Each block is 5 minutes. The first one appears after five minutes of tracking."
                : "Each block is 5 minutes — how much of it your keyboard or mouse moved. " +
                  "What you typed is never recorded.",
            TrayFontRole.Small, Muted);
    }

    /// <summary>
    /// The last image that went out: staff can see for themselves exactly what was sent.
    ///
    /// This is the most direct form of the window's central point: surveillance is not hidden.
    /// Careful: it is a thumbnail, so it cannot be read; the aim is to show "what picture went",
    /// not to re-read the image. To see it in full there is the "My data" page (J05).
    /// </summary>
    private void PaintLatestShot(TextStack stack, AgentStatus status)
    {
        var when = status.LatestShotAt is { } at ? UiText.Clock(at) : null;

        stack.Pair(
            "Latest screenshot",
            when ?? "None yet",
            TrayFontRole.Body);

        if (when is null)
        {
            stack.Gap(2);
            stack.Line(
                "Pictures are taken once every 5 minutes, at a random moment, and only " +
                "between 07:00 and 23:00 while you are working.",
                TrayFontRole.Small, Muted);
            return;
        }

        // a build without the preview (build.ps1 -HideLatestShot): the time
        // above says a picture was taken; the picture itself is not shown here
        if (!BuildOptions.ShowLatestShot)
        {
            stack.Gap(2);
            stack.Line(
                status.LatestShotMonitors > 1
                    ? $"All {UiText.Number(status.LatestShotMonitors)} screens were captured. The picture is not shown on this PC."
                    : "The picture is not shown on this PC.",
                TrayFontRole.Small, Muted);
            return;
        }

        stack.Gap(4);

        if (!stack.Thumbnail(status.LatestShotThumb, ThumbWidth))
        {
            stack.Line("The preview could not be loaded — the picture itself was still sent.",
                TrayFontRole.Small, Muted);
            return;
        }

        if (status.LatestShotMonitors > 1)
        {
            stack.Line(
                $"Screen 1 of {UiText.Number(status.LatestShotMonitors)} — every screen is captured.",
                TrayFontRole.Small, Muted);
        }
    }

    /// <summary>
    /// The meter's mark: "how much should be done by today".
    ///
    /// The server does not send this number separately, nor does it need to: pace is simply
    /// <b>what was done</b> minus <b>what should have been done</b>. So it is derived in
    /// reverse; that way the mark and the "behind/ahead" number come from <b>the same
    /// source</b>, and the two can never contradict each other.
    /// </summary>
    private static double? ExpectedRatio(AgentStatus status, TimeSpan? pace)
    {
        if (pace is not { } value) return null;
        if (status.MonthlyTargetHours <= 0) return null;

        var expected = status.ActiveThisMonth - value;
        if (expected <= TimeSpan.Zero) return null;

        var ratio = expected.TotalHours / status.MonthlyTargetHours;

        // At month end the expectation reaches 100%; there is no room to draw a mark beyond that
        return Math.Min(1.0, ratio);
    }

    /// <summary>The line under the meter: how much is left on the left, ahead or behind on the right.</summary>
    private void PaintLegend(TextStack stack, AgentStatus status, TimeSpan? pace)
    {
        var left = status.MonthlyRemaining <= TimeSpan.Zero
            ? "Target met"
            : UiText.Duration(status.MonthlyRemaining) + " left";

        /*
         * G111: "not yet observed" is not the same as "exactly on target".
         *
         * Careful: in this state the server sends pace as exactly 0, so the branch below would
         * write "0:00 ahead": a compliment on a new employee's first day with not a single
         * observation behind it.
         *
         * Careful: **this branch comes before `PaceOf`**, and that is the whole point: placed
         * later, the estimate (`MonthlyPace.Estimate`) would already have been chosen, and it
         * counts from the 1st of the month, so it would show exactly those unobserved days as a
         * shortfall. Fixing one false reassurance would create a false accusation in the other
         * direction.
         */
        var view = MonthlyPace.ViewFor(status.PaceObserved, status.Pace, pace);

        if (view is MonthlyPace.PaceView.NotObserved)
        {
            stack.Legend(left, "Not observed yet", Theme.Ink3);
            return;
        }

        if (view is MonthlyPace.PaceView.None || pace is not { } value)
        {
            stack.Legend(left, string.Empty, Theme.Ink3);
            return;
        }

        var ahead = value >= TimeSpan.Zero;

        // Careful: the sign is already in the text ("ahead"/"behind"), so the number is always
        // in positive form. UiText.Duration turns a negative into zero, so without taking Abs
        // every staff member who is "behind" would see "0:00 behind".
        var text = UiText.Duration(value.Duration()) + (ahead ? " ahead" : " behind");

        // Careful: if it is our guess and not the server's number, it must not be hidden; the
        // word is our admission that we do not know about holidays.
        if (view is MonthlyPace.PaceView.Estimated) text += " (estimated)";

        // Being behind is **amber**, not red. In this window red is only for "data is not
        // reaching the server": that is a system failure, and being behind is not an incident.
        stack.Legend(left, text, ahead ? Theme.Ok : Theme.Idle);
    }

    /// <summary>
    /// "Ahead or behind" (B05b/J02).
    ///
    /// If the server sends the number, that is what is used: it is the dashboard's number, and
    /// seeing two numbers in two places makes staff assume one is lying.
    /// If the server does not send it, <see cref="MonthlyPace"/>'s estimate, with "estimated"
    /// in the label itself. Careful: do not remove that word; it is our admission that we do
    /// not know about holidays.
    ///
    /// If there is no target at all (target 0) the line is omitted: "0:00 hours ahead" is meaningless.
    /// </summary>
    private static TimeSpan? PaceOf(AgentStatus status, DateTimeOffset now) =>
        status.Pace
        ?? MonthlyPace.Estimate(status.ActiveThisMonth, status.MonthlyTargetHours, now);

    /// <summary>
    /// What is written in the pill next to the number.
    ///
    /// Careful: the order follows <see cref="TrackingGate"/>: sign-in and revoke first, then
    /// pause, then the running state. Reversed, a revoked device would also say "Idle", as if
    /// it would start again at any moment.
    /// </summary>
    private static string HeroState(AgentStatus status) =>
        TrackingGate.Check(status.Enrolled, status.Health is SyncHealth.Revoked) switch
        {
            TrackingGate.Verdict.NotEnrolled => "Not signed in",
            TrackingGate.Verdict.Revoked => "Stopped",
            _ => status.Paused ? "Tracking paused" : TrayTooltip.StateName(status.State),
        };

    /// <summary>
    /// Whether the clock is really running right now: the only condition for the live number.
    ///
    /// In idle the number is <b>correctly frozen</b>: the rule is "if the hands do not move for
    /// 60 seconds, counting stops and that time is excluded from the total", and it is
    /// written at the bottom of the window. If the clock ran during idle too, the window
    /// would contradict its own text.
    ///
    /// Careful: when not signed in or revoked nothing is counted at all (TrackingGate), and
    /// not during a pause either.
    /// </summary>
    private static bool IsCounting(AgentStatus status) =>
        TrackingGate.Allows(status.Enrolled, status.Health is SyncHealth.Revoked)
        && !status.Paused
        && status.State == SegmentState.Active;

    /// <summary>The same dot language as the Live Board: green running · amber paused · grey locked.</summary>
    private Color StateDot(AgentStatus status)
    {
        // Careful: the green dot is a promise that "everything is running fine". If not
        // signed in that is false, so the color changes first, before the text is read.
        if (!status.Enrolled) return Theme.Brand;

        return status.Paused
            ? Theme.Ink3
            : status.State switch
            {
                SegmentState.Active => Theme.Ok,
                SegmentState.Idle => Theme.Idle,
                _ => Theme.Ink3,
            };
    }

    private static string HealthName(SyncHealth health) => health switch
    {
        SyncHealth.Ok => "OK",
        SyncHealth.Degraded => "Running late",
        SyncHealth.Failing => "Not reaching server",
        _ => "Stopped",
    };

    /// <summary>
    /// The progress fill is <b>green</b> (<c>Theme.Ok</c>): the owner's request
    /// (18 August): "work in progress = green".
    ///
    /// Careful: it used to be neutral <c>ink</c> while running, green only when the target was
    /// full ([09 § 3u](../../../../docs/09-Build-Log.md)). The owner wanted the fill green,
    /// first on the web and then in this window too, so that the two screens match.
    /// (Even earlier it was <c>#4A6FA5</c>, a blue that appears nowhere in oXeio.)
    /// </summary>
    private Color ProgressFill => Theme.Ok;

    private static string DefaultDetail(SyncHealth health) => health switch
    {
        SyncHealth.Failing => TrayTooltip.SyncFailingLine,
        SyncHealth.Revoked => TrayTooltip.RevokedLine,
        _ => "Sync is running a little late",
    };
}
