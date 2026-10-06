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

/// <summary>Sending to the server: the sync loop, the outbox budget, and the heartbeat.</summary>
internal sealed partial class AgentHost
{
    private async Task SyncLoopAsync(CancellationToken ct)
    {
        // Once, right at startup. Careful: this is the most important call. Any growth of the queue
        // while the agent was off (or after a crash) is caught here, before the first upload.
        // (`_lastBudgetSweep` is still MinValue, so OutboxSweep recognises this as Startup.)
        await MaybeEnforceOutboxBudgetAsync(ct);

        while (!ct.IsCancellationRequested)
        {
            if (_worker is not null) await _worker.DrainOnceAsync(ct);

            await MaybeEnforceOutboxBudgetAsync(ct);

            PublishStatus();

            try { await Task.Delay(SyncEvery, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// Enforce the queue's disk budget.
    ///
    /// Careful: the contract was already written in the doc of
    /// <see cref="SqliteOutboxStore.EnforceBudgetAsync"/>: <i>"the sync worker is the only caller
    /// (once at startup, then once an hour, and immediately whenever <c>LastWriteError</c>
    /// appears)"</i>. <b>The caller was never written.</b> So the 2 GiB cap, the 7-day age limit
    /// and the eviction order were all built and sat unused, and a PC that stayed offline for a
    /// week would have kept growing its queue.
    ///
    /// Why run immediately on <c>LastWriteError</c>: at that moment the disk has just filled, so
    /// that is exactly when space must be freed. Waiting for the hour would silently lose the data
    /// from the time in between.
    /// </summary>
    private async Task MaybeEnforceOutboxBudgetAsync(CancellationToken ct)
    {
        if (_outbox is null) return;

        var reason = OutboxSweep.Check(
            _lastBudgetSweep, _clock.Now, BudgetSweepEvery,
            hasWriteError: _outbox.LastWriteError is not null);

        if (reason == OutboxSweep.Reason.No) return;

        await EnforceOutboxBudgetAsync(Describe(reason), ct);
    }

    private static string Describe(OutboxSweep.Reason reason) => reason switch
    {
        OutboxSweep.Reason.Startup => "startup",
        OutboxSweep.Reason.WriteFailed => "the outbox could not write",
        _ => "hourly",
    };

    private async Task EnforceOutboxBudgetAsync(string why, CancellationToken ct)
    {
        if (_outbox is null) return;

        _lastBudgetSweep = _clock.Now;

        try
        {
            var plan = await _outbox.EnforceBudgetAsync(OutboxBudget.Default, _clock.Now, ct);

            // Careful: anything dropped is <b>always</b> logged. If dropped silently, a machine
            // could lose data for months and the report would only show "their hours are low",
            // putting the suspicion on the staff member rather than the agent. (Row-level detail
            // goes to DropLog.)
            if (!plan.IsEmpty)
            {
                _log.Warn(
                    $"Outbox trimmed ({why}): {plan.ExpiredRowIds.Count} past the age limit, " +
                    $"{plan.OverBudgetRowIds.Count} over the disk budget");
            }

            /**
             * <b>Orphan file sweep.</b>
             *
             * Careful: <see cref="SqliteOutboxStore.SweepOrphanFilesAsync"/> was written and had
             * its own test, but <b>nobody ever called it</b>. This is the repo's most familiar sin:
             * the contract is written, the caller is not (G141, G144, G146).
             *
             * Careful: the result is silent. An orphan <c>.webp</c> is <b>not counted in any
             * budget</b> (the budget counts rows, not files), so the leak could go on for months
             * and nobody would notice before the disk filled.
             *
             * It is called here because this is already the hourly maintenance path; a separate
             * timer would be one more thing someone could forget to call.
             *
             * Careful: a one-hour grace period applies (the default). Capture writes the file
             * first, then calls Enqueue; sweeping in that gap would delete the image just taken.
             */
            var orphans = await _outbox.SweepOrphanFilesAsync(_clock.Now, ct: ct);
            if (orphans > 0)
            {
                _log.Warn($"Outbox swept ({why}): {orphans} orphan file(s) with no row");
            }
        }
        catch (Exception ex)
        {
            // Careful: if pruning fails, sync does not stop, and certainly not tracking.
            _log.Error("Could not enforce the outbox budget", ex);
        }
    }

    /**
     * <b>The bell that wakes the heartbeat when the state changes.</b>
     *
     * Careful: this came from the owner's complaint: after going from idle to working, the board
     * took 10-15 seconds to show "Working". It was not a bug: the agent notices within a second,
     * but the server only learns at a heartbeat, which comes every 15 seconds.
     *
     * The damage is to trust: the owner sees "Idle" on screen, walks over, and finds the person
     * typing. After this happens twice, the whole board is no longer trusted.
     *
     * Careful: the rule for how often it may wake lives in <see cref="HeartbeatUrgency"/>, not
     * here, otherwise that number could not be tested.
     */
    private readonly SemaphoreSlim _stateChanged = new(0, 1);

    /// <summary>When the last heartbeat went out, for the interval calculation.</summary>
    private DateTimeOffset _lastBeatAt;

    /// <summary>
    /// Called from the tracker thread when the state changes.
    ///
    /// Careful: the semaphore's ceiling is 1, so several changes do not pile up: one wake-up is
    /// enough, and when it is full <c>Release</c> would throw.
    /// </summary>
    private void NudgeHeartbeat()
    {
        if (_stateChanged.CurrentCount == 0)
        {
            try { _stateChanged.Release(); }
            catch (SemaphoreFullException) { /* another thread already woke it */ }
        }
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_credentials?.IsEnrolled == true && _sync is not null)
                {
                    // Keep exactly the number being sent: it is needed to compute the offset
                    // against the server's reply.
                    var sentTodaySec = (int)Math.Clamp(
                        Interlocked.Read(ref _activeTodaySec), 0, 86_400);

                    var result = await _sync.HeartbeatAsync(new HeartbeatRequest
                    {
                        State = _machine!.State,
                        ActiveSecToday = sentTodaySec,
                        QueueDepth = _worker?.Depth.ForHeartbeat,
                        ConfigVersion = _configVersion,
                        AgentVersion = _version,
                        Capabilities = CapabilityReport.ToWire(
                            CapabilityReport.Build(CapabilityFactsNow())),
                    }, ct);

                    if (result.IsSuccess && result.Value is { } body)
                    {
                        if (body.Progress is not null)
                        {
                            _progress = body.Progress;

                            // The offset is however far the server is ahead of us.
                            // Careful: if negative, use 0. The server being **behind** is normal
                            // (segments are sitting in the queue) and is no reason to subtract from
                            // our own count.
                            Interlocked.Exchange(
                                ref _todayOffsetSec,
                                Math.Max(0, body.Progress.TodayActiveSec - sentTodaySec));
                        }

                        // **This is where config changes were silently dead all along.** The line
                        // used to be just `_configVersion = body.ConfigVersion;`, so the agent
                        // blindly accepted the server's version number but never fetched the
                        // config. At the next heartbeat the versions matched, so the server never
                        // asked for `reload_config` again, and whatever was changed in the
                        // dashboard's Settings, none of the 15 PCs ever knew.
                        if (NeedsConfig(body))
                        {
                            await ReloadConfigAsync(ct);
                        }

                        PublishStatus();
                    }
                    else if (result.Outcome == SyncOutcome.Revoked)
                    {
                        _credentials.Revoke("Revoked by the server");
                    }
                }
            }
            catch (Exception ex)
            {
                _log.Error("Heartbeat failed", ex);
            }

            _lastBeatAt = _clock.Now;

            /**
             * Wakes on a state change, but not more often than
             * <see cref="HeartbeatUrgency.MinGap"/>.
             *
             * Careful: <c>WaitAsync</c> returns immediately on a signal, otherwise when the time
             * runs out. Neither is an exception: it only throws when cancelled.
             */
            try
            {
                var wait = HeartbeatUrgency.Next(
                    _clock.Now, _lastBeatAt, HeartbeatDelay(), stateChanged: false);

                if (await _stateChanged.WaitAsync(wait, ct))
                {
                    // woke on a state-change signal: is it time to send now?
                    var extra = HeartbeatUrgency.Next(
                        _clock.Now, _lastBeatAt, HeartbeatDelay(), stateChanged: true);

                    if (extra > TimeSpan.Zero) await Task.Delay(extra, ct);
                }
            }
            catch (OperationCanceledException) { return; }
        }
    }
}
