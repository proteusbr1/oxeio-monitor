using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Platform;
using oXeio.Agent.Security;
using oXeio.Core.Agent;
using oXeio.Core.Models;
using oXeio.Core.Tracking;
using oXeio.Core.Watchdog;

namespace oXeio.Agent;

/// <summary>
/// <b>The agent watching its own resource use</b>: measure, report in the heartbeat, and above the
/// ceiling restart cleanly.
///
/// Why it exists: <c>nvspcap64.dll</c>, injected by an NVIDIA overlay, leaked ~217,000 handles and
/// 7 GB of private memory in one agent over twelve days. The trigger is fixed in the capture code;
/// this is the defence in depth for the next DLL that finds another one.
///
/// <b>The planned restart, end to end:</b>
/// <list type="number">
/// <item><see cref="ResourceCeiling.Decide"/> (pure, Core) says <c>Restart</c>: over the ceiling,
/// old enough, not restarted in the last 6 h, a watchdog present, and a quiet moment (or 2× over,
/// or over for an hour).</item>
/// <item>The <c>agent.ceiling</c> stamp is written first: the loop guard must hold even if the exit
/// goes wrong.</item>
/// <item><c>agent_restart</c> is queued (the server's G02 then treats the <c>agent_stop</c> that
/// follows as clean), then <c>agent.restart</c> is written for the watchdog.</item>
/// <item><c>Application.Exit</c> on the UI thread: <c>Application.Run()</c> returns and
/// <c>Program.Shutdown</c> runs the normal <see cref="DisposeAsync"/>: open segment closed,
/// <c>agent_stop</c> with <c>reason: agent_restart</c>, final drain, lock released.</item>
/// <item>The watchdog's next tick (≤30 s) finds the lock free and a fresh marker:
/// <see cref="WatchdogReason.PlannedRestart"/>, started at once and not counted on the ladder.</item>
/// </list>
/// </summary>
internal sealed partial class AgentHost
{
    private PlannedRestartStore? _restartStore;

    /// <summary>The last successful measurement; what the next heartbeat sends.</summary>
    private volatile ResourceSample? _resources;

    private DateTimeOffset _lastCeilingCheck = DateTimeOffset.MinValue;
    private DateTimeOffset? _overCeilingSince;

    private (CeilingAction, CeilingReason)? _lastCeilingLogged;
    private DateTimeOffset _lastCeilingLogAt = DateTimeOffset.MinValue;

    /// <summary>Once per process: a second request would only race the first one's shutdown.</summary>
    private int _ceilingRestartRequested;

    /// <summary>
    /// Set on the first heartbeat that a server refused while carrying the resource fields.
    ///
    /// Careful: a server older than these fields does not ignore them: under
    /// <c>forbidNonWhitelisted</c> it 400s the <b>whole heartbeat</b>, revoke and update offers
    /// included. If the agent were rolled out before the server, every PC would lose its commands
    /// until someone noticed. So on that 400 the fields are dropped for the rest of this process
    /// and the heartbeat is sent again without them; the next process tries once more, which is
    /// how it starts reporting the day the server catches up.
    /// </summary>
    private volatile bool _resourceTelemetryRefused;

    /// <summary>How often the "still over the ceiling" line is repeated when nothing changes.</summary>
    private static readonly TimeSpan CeilingLogEvery = TimeSpan.FromHours(1);

    /// <summary>How long the exit waits for <c>agent_restart</c> to reach SQLite.</summary>
    private static readonly TimeSpan RestartEventWait = TimeSpan.FromMilliseconds(500);

    /// <summary>The report for the next heartbeat, or <c>null</c> if unknown or refused by the server.</summary>
    private ResourceSample? ResourcesForHeartbeat() => _resourceTelemetryRefused ? null : _resources;

    /// <summary>
    /// The heartbeat with the resource report, falling back once to the heartbeat without it (see
    /// <see cref="_resourceTelemetryRefused"/>).
    /// </summary>
    private async Task<SyncResult<HeartbeatResponse>> SendHeartbeatAsync(
        HeartbeatRequest request, CancellationToken ct)
    {
        var result = await _sync!.HeartbeatAsync(request, ct);

        if (result.Outcome == SyncOutcome.Permanent && request.Resources is not null)
        {
            _resourceTelemetryRefused = true;
            _log.Warn("The server refused the heartbeat's resource report — sending it without the report " +
                      "from now on (the server is older than this agent)");

            result = await _sync.HeartbeatAsync(request with { Resources = null }, ct);
        }

        return result;
    }

    /// <summary>
    /// Once per heartbeat-loop turn (every 15 s to 5 min): measure, and at most once a
    /// <see cref="ResourceCeiling.CheckEvery"/> judge the ceiling.
    ///
    /// Careful: it runs whether or not the device is signed in. A leaking agent that was never
    /// enrolled still slows the PC down, and its restart costs nobody any counted time.
    ///
    /// Careful: the disk is touched (stamp, watchdog lock) only when already over the ceiling, so
    /// the healthy case, which is every PC almost always, costs four syscalls and nothing else.
    /// </summary>
    private async Task CheckResourcesAsync()
    {
        var sample = ResourceProbe.Read();
        if (sample is null) return;

        _resources = sample;
        if (_beacon is not null) _beacon.Resources = sample;

        var now = _clock.Now;
        if (now - _lastCeilingCheck < ResourceCeiling.CheckEvery) return;
        _lastCeilingCheck = now;

        if (!ResourceCeiling.IsOver(sample))
        {
            if (_overCeilingSince is not null)
                _log.Info($"Resources back under the ceiling — {Describe(sample)}");

            _overCeilingSince = null;
            _lastCeilingLogged = null;
            return;
        }

        var store = _restartStore ??= new PlannedRestartStore(AgentDataDirectory.Default);

        var decision = ResourceCeiling.Decide(new CeilingInput
        {
            Sample = sample,
            Now = now,
            OverSince = _overCeilingSince,
            Uptime = _clock.Elapsed,
            Quiet = IsQuietMoment(),
            ShuttingDown = IsLeaving(),
            WatchdogPresent = store.WatchdogPresent(),
            LastRestartUtc = store.LastCeilingRestart(),
            NowUtc = DateTimeOffset.UtcNow,
        });

        _overCeilingSince = decision.OverSince;
        LogCeiling(decision, sample, now);

        if (decision.Action == CeilingAction.Restart)
            await RequestCeilingRestartAsync(store, sample, decision.Reason);
    }

    /// <summary>
    /// Nobody loses counted time if the agent restarts now: idle, locked, the session suspended,
    /// or nothing being tracked at all (not signed in, revoked).
    ///
    /// Careful: <b>outside the capture window is deliberately not "quiet"</b>. The window governs
    /// screenshots only; ACTIVE time is counted around the clock, so restarting while someone types
    /// at 19:00 loses the same ~30 seconds as at 11:00.
    /// </summary>
    private bool IsQuietMoment()
    {
        if (!TrackingGate.Allows(_credentials?.IsEnrolled == true, _credentials?.IsRevoked == true))
            return true;

        if (_sessionSuspended) return true;

        return _machine?.State is SegmentState.Idle or SegmentState.Locked;
    }

    /// <summary>Already on the way out: our own shutdown, or Windows' (logoff/shutdown/update seen).</summary>
    private bool IsLeaving()
    {
        if (_stopping.IsCancellationRequested) return true;

        lock (_closingEventsSent)
        {
            return _closingEventsSent.Contains(AgentEventTypes.Shutdown)
                   || _closingEventsSent.Contains(AgentEventTypes.Logoff)
                   || _closingEventsSent.Contains(AgentEventTypes.AgentUpdate);
        }
    }

    private async Task RequestCeilingRestartAsync(
        PlannedRestartStore store, ResourceSample sample, CeilingReason why)
    {
        if (Interlocked.Exchange(ref _ceilingRestartRequested, 1) != 0) return;

        _log.Warn($"Restarting the agent to free its resources ({Describe(why)}) — {Describe(sample)}");

        // 1. The loop guard first (see PlannedRestartStore.TryStampCeilingRestart).
        if (!store.TryStampCeilingRestart(DateTimeOffset.UtcNow, out var stampError))
        {
            // Careful: without the stamp a fresh process over the ceiling would restart again in
            // 15 minutes, and again: the restart loop the stamp exists to prevent. Not restarting
            // is the safe side; the next check tries again.
            _log.Warn($"Could not write the restart stamp ({stampError}) — not restarting");
            Volatile.Write(ref _ceilingRestartRequested, 0);
            return;
        }

        // 2. The companion of agent_stop for the server (AgentEventTypes.AgentRestart). Awaited
        //    with a ceiling so the final drain in DisposeAsync finds the row already in SQLite.
        if (RaiseClosingEvent(
                AgentEventTypes.AgentRestart,
                out var queued,
                new Dictionary<string, object?>
                {
                    ["reason"] = "resource_ceiling",
                    ["trigger"] = why.ToString(),
                    ["handleCount"] = sample.HandleCount,
                    ["privateBytes"] = sample.PrivateBytes,
                    ["gdiObjects"] = sample.GdiObjects,
                    ["userObjects"] = sample.UserObjects,
                    ["injectedModules"] = sample.InjectedModules.ToArray(),
                }))
        {
            try { await queued.WaitAsync(RestartEventWait); }
            catch (TimeoutException) { /* still being written; the drain picks it up */ }
        }

        // 3. The watchdog's signal. Careful: last, right before the exit, so its unbiased stamp is
        //    as close as possible to the moment the lock is released.
        if (PlannedRestartStore.UnbiasedMs() is { } unbiased
            && !store.TryWriteMarker(new PlannedRestart
            {
                ProcessId = Environment.ProcessId,
                UnbiasedMs = unbiased,
                Reason = "resource_ceiling",
                WrittenAtUtc = DateTimeOffset.UtcNow,
                HandleCount = sample.HandleCount,
                PrivateBytes = sample.PrivateBytes,
            }, out var markerError))
        {
            // Not fatal: the watchdog still starts the agent, as "agent missing", on the ladder.
            _log.Warn($"Could not write agent.restart ({markerError}) — the watchdog will see an ordinary exit");
        }

        // 4. Leave through the normal door. Careful: Application.Exit belongs on the UI thread;
        //    from here (thread pool) it would raise FormClosing on the tray's windows from the
        //    wrong thread. TrayIcon.Post is the one route onto that thread.
        if (_tray is { } tray) tray.Post(Application.Exit);
        else Application.Exit();
    }

    private void LogCeiling(CeilingDecision decision, ResourceSample sample, DateTimeOffset now)
    {
        var key = (decision.Action, decision.Reason);
        if (key == _lastCeilingLogged && now - _lastCeilingLogAt < CeilingLogEvery) return;

        _lastCeilingLogged = key;
        _lastCeilingLogAt = now;

        if (decision.Action == CeilingAction.Restart) return; // RequestCeilingRestartAsync says it

        _log.Warn($"Over the resource ceiling — {Describe(decision.Reason)} — {Describe(sample)}");
    }

    private static string Describe(ResourceSample s)
    {
        var modules = s.InjectedModules.Count > 0 ? $", loaded: {string.Join(", ", s.InjectedModules)}" : "";
        return $"{s.HandleCount:N0} handles, {s.PrivateBytes / 1_048_576:N0} MB private, " +
               $"{s.GdiObjects} GDI, {s.UserObjects} USER{modules}";
    }

    private static string Describe(CeilingReason reason) => reason switch
    {
        CeilingReason.TooYoung => "the process is too young to restart yet",
        CeilingReason.BackedOff => "restarted for this less than 6 hours ago; only reporting",
        CeilingReason.NoWatchdog => "no watchdog is running to start it again; only reporting",
        CeilingReason.WaitingForQuiet => "waiting for an idle or locked moment",
        CeilingReason.QuietMoment => "idle or locked now",
        CeilingReason.HardCeiling => "more than twice the ceiling",
        CeilingReason.OverTooLong => "over the ceiling for an hour",
        CeilingReason.ShuttingDown => "already shutting down",
        _ => reason.ToString(),
    };
}
