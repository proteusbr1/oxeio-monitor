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

/// <summary>Screenshots: the capture loop, screen sampling, and the latest-shot preview.</summary>
internal sealed partial class AgentHost
{
    /**
     * The screenshot slot <b>and</b> the screen fingerprint: both in this single loop.
     *
     * Careful: <b>the fingerprint used to run on the tracker thread, and that was wrong.</b> Two
     * threads then used <see cref="_capture"/> at once, although it was built from the start for a
     * single thread: it holds DXGI COM objects inside, and the same output cannot be duplicated
     * twice.
     *
     * So there is <b>exactly one owner</b>: this loop. It sleeps until whichever comes first, the
     * screenshot slot or the fingerprint time. The fingerprint is still independent of the
     * screenshot rhythm, which was needed to avoid a deadlock.
     *
     * Careful: the two clocks are deliberately different. Slots run on the wall clock (they are
     * tied to fixed times of day), and the fingerprint runs on the monotonic clock
     * (<see cref="ScreenActivity"/> uses it too). Mixing them would let NTP corrections scramble
     * the calculation.
     */
    private async Task CaptureLoopAsync(CancellationToken ct)
    {
        var next = _slots!.Next(DateTimeOffset.UtcNow);

        while (!ct.IsCancellationRequested)
        {
            var wait = next.FireAt - DateTimeOffset.UtcNow;

            var untilSample = UntilNextScreenSample();
            if (untilSample < wait) wait = untilSample;

            if (wait > TimeSpan.Zero)
            {
                try { await Task.Delay(wait, ct); }
                catch (OperationCanceledException) { return; }
            }

            // Careful: it checks for itself whether it is time, and handles its own failures
            SampleScreen(_clock.Now);

            // Careful: if we woke for the fingerprint, the slot time has not come yet, so no
            // screenshot
            if (DateTimeOffset.UtcNow < next.FireAt) continue;

            try
            {
                await CaptureSlotAsync(next, ct);
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref _screenshotFailStreak);
                _log.Error("Capture slot failed", ex);
            }

            next = _slots.Next(DateTimeOffset.UtcNow);
        }
    }

    /**
     * <b>G46:</b> is the screen actually changing?
     *
     * Careful: samples come from <see cref="SampleScreen"/>, <b>not from the screenshot slot</b>,
     * and this separation is the most important decision here. The fingerprint used to come from
     * the slot, and slots ran only in the ACTIVE state. So: "frozen, then IDLE, then slot stops,
     * then no new fingerprint, then frozen forever". Even after the employee came back and worked,
     * the agent showed idle permanently.
     *
     * Careful: when capture is off (at night, outside the window in section 4.2, or on a locked
     * screen) no samples arrive, and once <see cref="ScreenActivity.StaleAfter"/> passes, the
     * suspicion lifts by itself. "Unknown" is not treated as an accusation.
     */
    private readonly ScreenActivity _screen = new();

    /// <summary>When a fingerprint was last attempted, even if it failed.</summary>
    private DateTimeOffset? _screenSampledAt;

    /// <summary>A failed fingerprint is logged only once.</summary>
    private bool _screenSampleFailed;

    /// <summary>
    /// Consecutive idle-probe readings Windows refused — written by the
    /// tracking loop, read by the heartbeat for <see cref="CapabilityReport"/>.
    /// </summary>
    private int _idleFailStreak;

    /// <summary>
    /// The last fingerprint attempt failed. Unlike <see cref="_screenSampleFailed"/>
    /// (which only keeps the log line to one) this goes back to false when a
    /// later attempt works, so the report does not stay red after recovery.
    /// </summary>
    private volatile bool _screenSampleFailing;

    /// <summary>Consecutive screenshot slots with no image — same use.</summary>
    private int _screenshotFailStreak;

    /**
     * <b>G46: taking the screen fingerprint.</b>
     *
     * Careful: called <b>from the capture loop</b>, not from the tracker thread, because
     * <see cref="_capture"/> must have exactly one owner (see <see cref="CaptureLoopAsync"/>).
     *
     * It is still independent of the screenshot <b>slot</b>: slots run only in the ACTIVE state,
     * and the fingerprint always runs. That difference is what avoids the deadlock; details in
     * <see cref="ScreenSampling"/>.
     *
     * Careful: on failure it returns quietly, but <see cref="_screenSampledAt"/> is still set.
     * Otherwise a machine with broken capture would retry every second.
     */
    /// <summary>How long until the next fingerprint, used to set the capture loop's
    /// sleep.</summary>
    private TimeSpan UntilNextScreenSample()
    {
        var now = _clock.Now;

        /**
         * <b>This very branch prevents a 100% CPU loop.</b>
         *
         * If <see cref="SampleScreen"/> cannot take a fingerprint, <see cref="_screenSampledAt"/>
         * stays <c>null</c>. This used to return <c>Zero</c> in that state, so
         * <see cref="CaptureLoopAsync"/>'s <c>wait</c> became zero, <c>Task.Delay</c> was skipped,
         * the slot time had not come so it hit <c>continue</c>, and the loop spun on one core.
         *
         * It happened in three real situations, all <b>before the first successful fingerprint</b>:
         *   1. A freshly installed PC that is not enrolled yet
         *   2. The agent starting outside office hours (outside 07:00-23:00)
         *   3. Starting while the screen is locked
         *
         * Fix: when there is nothing to do, sleep for <b>the normal interval</b>. The delay is at
         * most one interval and CPU use is zero.
         */
        if (!CanSampleNow()) return ScreenSampling.Interval;

        if (_screenSampledAt is null) return TimeSpan.Zero;

        var every = _screen.IsFrozen(now)
            ? ScreenSampling.WhenFrozen
            : ScreenSampling.Interval;

        var due = _screenSampledAt.Value + every - now;
        return due > TimeSpan.Zero ? due : TimeSpan.Zero;
    }

    /**
     * Whether taking a fingerprint is permitted right now at all.
     *
     * Careful: the conditions are <b>exactly the same</b> as in <see cref="SampleScreen"/>, and
     * both call <see cref="ScreenSampling.Allowed"/>. Written separately, one would change someday
     * and not the other, and the loop would start spinning again.
     */
    private bool CanSampleNow() =>
        _capture is not null
        && ScreenSampling.Allowed(
            _credentials?.IsEnrolled == true,
            _credentials?.IsRevoked == true,
            _window.Allows(_clock.Now),
            _sessionSuspended);

    private void SampleScreen(DateTimeOffset now)
    {
        // Careful: this condition is kept in one place with <see cref="CanSampleNow"/>. Written in
        // two places, one would change someday and not the other, and the capture loop would spin
        // at 100% CPU again.
        if (!CanSampleNow()) return;

        // Careful: the condition above already guarantees this, but the compiler cannot see it, and
        // writing `_capture!` would also hide a real null in the future.
        if (_capture is null) return;

        if (!ScreenSampling.Due(now, _screenSampledAt, _screen.IsFrozen(now))) return;

        _screenSampledAt = now;

        try
        {
            /**
             * <b>A fingerprint for every monitor.</b> Previously only the first screen was
             * fingerprinted, so for someone working on a second monitor the count stopped after ten
             * minutes.
             *
             * Careful: a screen whose fingerprint could not be made is skipped, but the others are
             * still sent. If none succeeds, nothing is reported, and then the <c>StaleAfter</c>
             * rule treats it as "unknown" and holds off suspecting anything.
             */
            var frames = _capture.CaptureEach();
            if (frames.Count == 0) return;

            var prints = new List<byte[]>(frames.Count);

            foreach (var frame in frames)
            {
                var print = ScreenFingerprint.From(frame);
                if (print is not null) prints.Add(print);
            }

            if (prints.Count > 0)
            {
                _screen.Observe(prints, now);
                _screenSampleFailing = false;
            }
        }
        catch (Exception ex)
        {
            /**
             * Careful: keeping counting alive is what matters; if no fingerprint arrives,
             * StaleAfter takes care of it.
             *
             * Careful: <b>this is written only once.</b> Writing every time would make the log file
             * on a machine with broken capture grow by one row per minute, and the rotation (H08)
             * would push out the real errors.
             */
            _screenSampleFailing = true;

            if (!_screenSampleFailed)
            {
                _screenSampleFailed = true;
                _log.Warn($"Screen fingerprint failed — jiggler detection is off on this PC: {ex.Message}");
            }
        }
    }

    private async Task CaptureSlotAsync(SlotScheduler.Slot slot, CancellationToken ct)
    {
        // All the conditions live in CaptureGate, because scattered here as guard clauses a missing
        // condition would not be caught by any test.
        var verdict = CaptureGate.Check(
            _machine!.State,
            _credentials?.IsEnrolled == true,
            _credentials?.IsRevoked == true,
            _window,
            slot.FireAt,
            _config.Screenshot.IsEnabled);

        if (verdict != CaptureGate.Verdict.Allowed)
        {
            // Careful: a revoke is reported once. Otherwise "silently stopped" and "working but
            // sending nothing" would look the same on screen.
            if (verdict == CaptureGate.Verdict.Revoked && !_revokeLogged)
            {
                _revokeLogged = true;
                _log.Warn("Device revoked — no more screenshots will be taken on this PC.");
            }

            return;
        }

        if (_outbox is null) return;

        var results = _capture!.CaptureAll();

        // for the capability report: an empty slot here is a capture failure
        if (results.Count == 0) Interlocked.Increment(ref _screenshotFailStreak);
        else Volatile.Write(ref _screenshotFailStreak, 0);

        // The foreground app and window title at that moment, stored with the image.
        //
        // Careful: deliberately <b>outside</b> the loop. There is one image per monitor, but only
        // one foreground window for the whole desktop. Inside the loop the rows of two monitors
        // could get different names (if the window changed midway), although the images are of the
        // same moment.
        //
        // Careful: if app tracking is off in the config, `_apps` is never created, so no name is
        // stored. It is "not known", not "not being sent" (see the tracking section above).
        var front = _apps?.Current;

        // Thumbnail of the last image, for the window: the leftmost screen
        string? showThumb = null;
        var showIndex = int.MaxValue;

        foreach (var r in results)
        {
            // Careful: the uuid is created first. The file name and the row's clientUuid must
            // match, otherwise the file and its metadata would lose each other.
            var uuid = Guid.NewGuid();

            var path = _outbox.Paths.NewScreenshotPath(slot.SlotStart, r.MonitorIndex, uuid);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(path, r.Webp, ct);

            // A small image for the grid. Careful: on failure, carry on quietly: without a
            // thumbnail the gallery shows the full image, but the real image must not be lost over
            // a thumbnail.
            var thumb = WebpEncoder.EncodeThumb(r.Webp);
            if (thumb is not null)
            {
                try
                {
                    await File.WriteAllBytesAsync(OutboxPaths.ThumbPathFor(path), thumb, ct);

                    if (r.MonitorIndex < showIndex)
                    {
                        showIndex = r.MonitorIndex;
                        showThumb = OutboxPaths.ThumbPathFor(path);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _log.Warn($"Could not write the thumbnail — the full image will be sent: {ex.Message}");
                }
            }

            var meta = new ScreenshotRecord
            {
                ClientUuid = uuid,
                SlotStart = slot.SlotStart,
                CapturedAt = DateTimeOffset.UtcNow,
                MonitorIndex = r.MonitorIndex,
                Width = r.Width,
                Height = r.Height,
                ActiveApp = front?.ProcessName,
                ActiveTitle = front?.WindowTitle,
            };

            await _outbox.EnqueueAsync(
                OutboxCodec.Item(meta, path, r.Webp.LongLength, DateTimeOffset.UtcNow), ct);
        }

        KeepLatestShot(showThumb, results.Count);

        /*
         * H08: <b>one line</b> per capture, one per slot.
         *
         * Careful: the lack of this line wasted about an hour one night. A slot had been skipped,
         * and there was no way to know why: DXGI failed, the window was closed, or the user was
         * idle at that moment. It had to be guessed by comparing against segment times (section 3),
         * and the first guess was wrong too.
         *
         * Careful: one line per slot, not per monitor: 288 lines a day, and 864 with three
         * monitors. That is enough for a 7-day log, and the other lines do not get pushed out.
         */
        /**
         * Careful: the slot time is shown in <b>Dhaka</b> time, not UTC.
         *
         * `slot.SlotStart` is UTC (`SlotScheduler.FloorToSlot` gives a zero offset), but the
         * **timestamp** of this line is written by `FileLog` in local time (`DateTimeOffset.Now`,
         * +06:00). If the two were not in one zone, the log would show "22:14 ... slot 16:10" side
         * by side: two times for one event, and whoever reads the log during an incident would have
         * to add 6 hours in their head. This confusion was caught in the G137 investigation.
         */
        _log.Info(
            $"📸 slot {DhakaTime.LocalTimeOf(slot.SlotStart):HH\\:mm} · {results.Count} monitor(s)" +
            (front is null ? "" : $" · {front.ProcessName}"));
    }

    /// <summary>
    /// Keep a <b>copy</b> of the last image, to show in the window.
    ///
    /// Careful: pointing at the file in the queue is not enough. When an upload succeeds, the sync
    /// worker <b>deletes</b> both the image and the thumbnail (within a few seconds). Opening the
    /// window then would show a blank where the image should be, wrongly saying "no image was
    /// captured".
    ///
    /// The thumbnail is what gets copied (4-11 KB), not the whole image: that is all the window
    /// shows, and copying a full image 192 times a day on each of 15 PCs makes no sense.
    /// </summary>
    private void KeepLatestShot(string? thumbPath, int monitors)
    {
        if (!BuildOptions.ShowLatestShot)
        {
            KeepLatestShotTimeOnly(monitors);
            return;
        }

        if (thumbPath is null || _outbox is null) return;

        try
        {
            Directory.CreateDirectory(_outbox.Paths.State);
            var target = Path.Combine(_outbox.Paths.State, "last-shot.webp");

            File.Copy(thumbPath, target, overwrite: true);

            _latestShotThumb = target;
            _latestShotAt = DateTimeOffset.UtcNow;
            _latestShotMonitors = monitors;

            PublishStatus();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Careful: showing the image matters less than capturing and sending it. If this fails,
            // carry on quietly so capture does not break.
            _log.Warn($"Could not keep the last thumbnail for the window: {ex.Message}");
        }
    }

    /// <summary>
    /// A build without the preview (<see cref="BuildOptions.ShowLatestShot"/>):
    /// the window still learns <i>when</i> the picture was taken, but no copy of
    /// it is kept — and one left by an earlier build is removed.
    /// </summary>
    private void KeepLatestShotTimeOnly(int monitors)
    {
        _latestShotThumb = null;
        _latestShotAt = DateTimeOffset.UtcNow;
        _latestShotMonitors = monitors;

        if (_outbox is not null)
        {
            var stale = Path.Combine(_outbox.Paths.State, "last-shot.webp");
            try
            {
                if (File.Exists(stale)) File.Delete(stale);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.Warn($"Could not remove the old preview copy: {ex.Message}");
            }
        }

        PublishStatus();
    }
}
