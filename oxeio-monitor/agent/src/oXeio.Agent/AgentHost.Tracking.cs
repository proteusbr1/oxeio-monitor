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

/// <summary>Activity tracking: the per-second loop, app usage, and recording closed segments.</summary>
internal sealed partial class AgentHost
{
    /// <summary>
    /// The per-second counting. Careful: no I/O here. When a segment closes it is only put on the
    /// queue, and the write happens on another thread.
    /// </summary>
    private void TrackLoop()
    {
        while (!_stopping.IsCancellationRequested)
        {
            try
            {
                var now = _clock.Now;
                var sample = _idle.Read();

                if (!sample.Valid)
                {
                    Interlocked.Increment(ref _idleFailStreak);

                    // Careful: no default is substituted, so this second is dropped. Losing one
                    // second is better than recording a wrong number.
                    Thread.Sleep(Tick);
                    continue;
                }

                Volatile.Write(ref _idleFailStreak, 0);

                // New config is applied here, not on the heartbeat thread. `_machine` and `_apps`
                // belong to this loop; changing them from another thread would send one Tick to the
                // old object and the next to the new one in that very second, and the time in
                // between would land in no segment. On the day the config changed, everyone would
                // lose a few hours.
                if (Interlocked.Exchange(ref _pendingConfig, null) is { } pending)
                {
                    ApplyConfig(pending.Config, pending.Version, now);
                }

                // If the device is revoked, tracking stops too, not just uploading. Earlier only
                // uploads stopped, so on a dismissed employee's PC segments and app usage kept
                // piling up.
                //
                // Careful: the same applies when not signed in. Before counting starts we need to
                // know **whose** hours they are. Otherwise on a machine that was installed and
                // left, the admin's time would pile up in the outbox and land on a staff member's
                // record the moment they signed in (TrackingGate).
                var gate = TrackingGate.Check(
                    _credentials?.IsEnrolled == true,
                    _credentials?.IsRevoked == true);

                if (gate != TrackingGate.Verdict.Allowed)
                {
                    // Careful: only a revoke needs to close the open segment. Before sign-in there
                    // cannot be an open segment.
                    if (gate == TrackingGate.Verdict.Revoked) StopTrackingForRevoke(now);

                    Thread.Sleep(Tick);
                    continue;
                }

                var gap = _sleep.Observe(
                    new SleepGapDetector.Sample(sample.BiasedMs, sample.UnbiasedMs, now));

                if (gap.Detected)
                {
                    // Careful: the change happens inside the lock, the queue write outside it
                    IReadOnlyList<ActivitySegment> slept, woke;
                    lock (_machineGate)
                    {
                        slept = _machine!.OnSuspend(gap.SuspendedAt);
                        woke = _machine!.OnResume(gap.ResumedAt);
                    }

                    Record(slept);
                    Record(woke);
                }

                // If the screen is frozen, the input timer is no longer trusted.
                //
                // Careful: fingerprint matching happens **before** the lock: it reads the screen,
                // and putting any heavy work inside the lock risks stalling the message pump.
                var frozen = _screen.IsFrozen(now);

                SegmentState before, after;
                IReadOnlyList<ActivitySegment> ticked;

                lock (_machineGate)
                {
                    before = _machine!.State;
                    ticked = _machine.Tick(
                        now, sample.SinceLastInput, _sessionSuspended, frozen);
                    after = _machine.State;
                }

                Record(ticked);

                /**
                 * Tell the server <b>immediately</b> when the state changes.
                 *
                 * Careful: without these three lines <see cref="HeartbeatUrgency"/> would exist and
                 * its test would pass, yet nothing on the board would change. This is the project's
                 * most familiar mistake ("the contract is written but the caller is not"), so the
                 * rule and the caller were written together.
                 */
                if (after != before) NudgeHeartbeat();
            }
            catch (Exception ex)
            {
                // Careful: if this thread dies, time counting stops for good. That is the worst
                // failure.
                _log.Error("Tracker tick failed — continuing", ex);
            }

            Thread.Sleep(Tick);
        }
    }

    /// <summary>
    /// Time spent per app or site (D01-D04).
    ///
    /// Careful: <b>a separate loop, not the tracker thread.</b> Reading the address bar needs UI
    /// Automation, which can block for up to 400 ms in a busy app
    /// (<see cref="Apps.BrowserUrlReader"/>). Putting it on the second-counting thread would delay
    /// the idle-measuring tick, and the per-second count is this system's core job.
    ///
    /// If this loop fails, app accounting is lost, not time accounting.
    /// </summary>
    private async Task AppUsageLoopAsync(CancellationToken ct)
    {
        if (_apps is null) return;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                // Careful: this gate is needed **separately**. The gate in TrackLoop does not stop
                // this loop: they are two different threads, and this loop queues its own rows.
                //
                // Found by measurement: even after TrackLoop and CaptureGate were gated, a row
                // piled up in 7 minutes: `oXeio.Agent.exe`, 300 seconds. That is, the time the
                // sign-in window stayed open was being recorded as app usage.
                if (TrackingGate.Allows(
                        _credentials?.IsEnrolled == true,
                        _credentials?.IsRevoked == true))
                {
                    RecordApps(_apps.Tick(_clock.Now, _machine?.State ?? SegmentState.Idle));
                }
            }
            catch (Exception ex)
            {
                _log.Error("App usage tick failed — continuing", ex);
            }

            try { await Task.Delay(Tick, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private void Record(IReadOnlyList<ActivitySegment> closed)
    {
        foreach (var s in closed)
        {
            if (s.CountsAsWork)
            {
                // today's count resets at midnight in the work zone (section 2.1)
                var date = WorkTime.WorkDateOf(s.StartedAt);
                if (date != _activeDate)
                {
                    _activeDate = date;
                    Interlocked.Exchange(ref _activeTodaySec, 0);
                }

                Interlocked.Add(ref _activeTodaySec, s.DurationSec);
            }

            RememberBusy(s);

            _outbox?.EnqueueAsync(OutboxCodec.Item(s, DateTimeOffset.UtcNow))
                   .ContinueWith(
                       t => _log.Error("Could not queue the segment", t.Exception),
                       TaskContinuationOptions.OnlyOnFaulted);
        }
    }

    /// <summary>
    /// H06: wind tracking down after a revocation. Runs once.
    ///
    /// Careful: the open segment is closed but **not queued**. The token is already deleted
    /// (`DeviceCredentials.Revoke`), so that row could never reach the server; it would only grow
    /// the outbox.
    ///
    /// Careful: app tracking stops too. On a revoked device there is no basis for storing "who was
    /// on which site".
    /// </summary>
    private void StopTrackingForRevoke(DateTimeOffset now)
    {
        if (_trackingStoppedForRevoke) return;
        _trackingStoppedForRevoke = true;

        lock (_machineGate) _machine?.CloseAll(now);

        if (_apps is not null)
        {
            _apps.CloseAll(now);
            _apps = null;
        }

        _log.Warn("Device revoked — tracking stopped on this PC.");
        PublishStatus();
    }

    /// <summary>
    /// B13: what percentage of time the hands were moving in the last few cells, for the tray.
    ///
    /// The number is not measured anew: <see cref="ActivitySegment.InputScore"/> already exists,
    /// and segments are cut at most every 5 minutes (G53). So "how busy per 5 minutes" is already
    /// computed and sent to the server; it just was not shown until now.
    ///
    /// Careful: <c>locked</c> cells are left out. Saying "0% busy" for a locked screen would be
    /// misleading, because the person was not working then. An <c>idle</c> cell gets 0, because
    /// that really is "was at the desk, hands not moving".
    /// </summary>
    private void RememberBusy(ActivitySegment s)
    {
        if (s.State == SegmentState.Locked) return;

        lock (_busyGate)
        {
            _recentBusy.Enqueue(s.InputScore ?? 0);
            while (_recentBusy.Count > BusyBlocks) _recentBusy.Dequeue();
        }
    }

    private void RecordApps(IReadOnlyList<AppUsageRecord> closed)
    {
        foreach (var a in closed)
        {
            _outbox?.EnqueueAsync(OutboxCodec.Item(a, DateTimeOffset.UtcNow))
                   .ContinueWith(
                       t => _log.Error("Could not queue app usage", t.Exception),
                       TaskContinuationOptions.OnlyOnFaulted);
        }
    }
}
