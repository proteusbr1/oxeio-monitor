using System.Diagnostics;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Apps;
using oXeio.Agent.Native;
using oXeio.Agent.Platform;
using oXeio.Agent.Platform.Capture;
using oXeio.Agent.Security;
using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Agent.Ui;
using oXeio.Core.Agent;
using oXeio.Core.Capture;
using oXeio.Core.Models;
using oXeio.Core.Time;
using oXeio.Core.Tracking;

namespace oXeio.Agent;

/// <summary>The status shown in the tray: today's worked time and the snapshot.</summary>
internal sealed partial class AgentHost
{
    /// <summary>
    /// Work so far today, <b>up to this second</b>.
    ///
    /// Three parts: the server offset (work before the agent started) + today's closed segments +
    /// <b>whatever part of the current segment is running now</b>.
    ///
    /// Careful: the last part used to be missing, and it was the root of "the seconds do not tick":
    /// <c>_activeTodaySec</c> grows only when a segment is <b>closed</b>, and segments are cut at
    /// most every 5 minutes (<c>IdleStateMachine.MaxSegmentLength</c>), so the number stayed still
    /// for 5 minutes and then jumped by 5 minutes.
    ///
    /// Careful: the open segment is computed <b>here</b>, on `_clock` (monotonic), not in the
    /// window. The window reads the wall clock; mixing two timelines would be wrong.
    ///
    /// Careful: only added while ACTIVE; idle means counting has stopped (section 2.1), and so do
    /// lock and suspend.
    /// </summary>
    private TimeSpan TodayWorked(EmployeeProgress? progress)
    {
        var counted = Interlocked.Read(ref _todayOffsetSec)
                      + Interlocked.Read(ref _activeTodaySec);

        // G160: state and time under **one lock**. Read separately, a transition could happen in
        // between, pairing the old state with the new `_openedAt`, and today's total would suddenly
        // drop.
        if (_machine is { } machine)
        {
            var (state, openedAt) = machine.Peek();

            if (state == SegmentState.Active)
            {
                var openFor = _clock.Now - openedAt;
                if (openFor > TimeSpan.Zero) counted += (long)openFor.TotalSeconds;
            }
        }

        // Careful: if the server's number is ever higher than ours, use it; it knows the sum across
        // multiple devices, we do not.
        if (progress?.TodayActiveSec is { } serverSec && serverSec > counted)
        {
            counted = serverSec;
        }

        return TimeSpan.FromSeconds(counted);
    }

    private AgentStatus Snapshot()
    {
        var depth = _worker?.Depth.Total ?? 0;
        var progress = _progress;

        return new AgentStatus
        {
            State = _machine?.State ?? SegmentState.Idle,

            // H04: the tray's "Install update" item depends on this
            Update = _updates?.Status ?? UpdateStatus.Idle,

            // Today's count is the server's; the agent's own resets on reboot. If the server has
            // not said anything yet (no heartbeat so far), use our own.
            ActiveToday = TodayWorked(progress),

            // The number above is **as of this moment**; from here the window counts seconds itself
            // (LiveDuration). Careful: deliberately the wall clock (`UtcNow`), not `_clock`: the
            // window also measures on the wall clock, and mixing two timelines would make the
            // difference meaningless.
            CountedAt = DateTimeOffset.UtcNow,
            ActiveThisMonth = TimeSpan.FromSeconds(progress?.MonthActiveSec ?? 0),
            MonthlyTargetHours = progress?.MonthlyTargetHours ?? 208,
            NoTarget = progress?.NoTarget ?? false,

            // Careful: before the first heartbeat the month cell is a false zero; the place that
            // shows it must be told (AgentStatus.MonthlyKnown).
            MonthlyKnown = progress is not null,

            // Careful: if the server does not send it, it stays null, not 0: "we do not know" and
            // "on target" are not the same thing (see AgentStatus.Pace).
            Pace = progress?.PaceSec is { } sec ? TimeSpan.FromSeconds(sec) : null,

            // G111: whether the 0 above means "on target" or "not looked at yet". Careful: `!=
            // false`, so if the server says nothing (null) behaviour is as before.
            PaceObserved = progress?.Observed != false,

            // Careful: here too, null means "the server did not say"; Zero means "day off today".
            DailyTarget = progress?.DailyTargetSec is { } day
                ? TimeSpan.FromSeconds(day)
                : null,
            ActiveLast7 = progress?.Week7ActiveSec is { } w7
                ? TimeSpan.FromSeconds(w7)
                : null,
            Last7Target = progress?.Week7TargetSec is { } w7t
                ? TimeSpan.FromSeconds(w7t)
                : null,

            RecentBusy = SnapshotBusy(),

            LatestShotThumb = _latestShotThumb,
            LatestShotAt = _latestShotAt,
            LatestShotMonitors = _latestShotMonitors,

            QueueDepth = depth,
            LastSyncAt = _worker?.LastSuccessAt,
            Health = _worker?.Health ?? SyncHealth.Ok,
            HealthDetail = _worker?.HealthDetail,
            Paused = false,

            // Careful: IsEnrolled is not the opposite of NeedsEnrollment. If the credentials file
            // exists but cannot be read (corrupt, or DPAPI from another machine), both are false,
            // and saying "already signed in" would then simply be wrong.
            Enrolled = _credentials?.IsEnrolled == true,
        };
    }

    /// <summary>Careful: a copy is returned, not the internal queue, so the list cannot change
    /// under the UI thread mid-draw.</summary>
    private int[] SnapshotBusy()
    {
        lock (_busyGate) return [.. _recentBusy];
    }

    private void PublishStatus() => _tray?.Publish(Snapshot());
}
