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

/// <summary>Configuration received from the server, and applying it.</summary>
internal sealed partial class AgentHost
{
    private TimeSpan HeartbeatDelay()
    {
        var wanted = TimeSpan.FromSeconds(_config.HeartbeatSec);
        return wanted < HeartbeatMin ? HeartbeatMin
             : wanted > HeartbeatMax ? HeartbeatMax
             : wanted;
    }

    /// <summary>
    /// Whether the config must be fetched again.
    ///
    /// Two reasons: the server explicitly said <c>reload_config</c>, <b>or</b> the versions do not
    /// match. Careful: the second is not just belt and braces. When the agent has just started,
    /// <see cref="_configVersion"/> is <c>null</c>, and then the server sends no command (in its
    /// view "nothing changed"). Relying on the command alone, after a reboot the agent would run on
    /// the default config forever.
    /// </summary>
    private bool NeedsConfig(HeartbeatResponse body) =>
        body.Commands.Contains(AgentCommand.ReloadConfig) ||
        !string.Equals(_configVersion, body.ConfigVersion, StringComparison.Ordinal);

    /// <summary>
    /// <c>GET /agent/config</c>: fetch it and <b>put it in the slot</b>, do not apply it
    /// immediately.
    ///
    /// Careful: <see cref="TrackLoop"/> applies it, because the tracking objects belong to that
    /// thread. Touching them from here would split the per-second count across two configs.
    ///
    /// On failure, carry on quietly with the old config. Not getting a config does not mean
    /// counting stops (see the comment on <see cref="AgentConfig.Default"/>).
    /// </summary>
    private async Task ReloadConfigAsync(CancellationToken ct)
    {
        if (_sync is null) return;

        var result = await _sync.GetConfigAsync(ct);

        if (!result.IsSuccess || result.Value is not { } body)
        {
            _log.Warn($"Could not fetch the config — carrying on with the current one ({result.Detail ?? "reason unknown"})");
            return;
        }

        // ⚠️ A config that is not usable is neither applied nor kept: the
        //    agent carries on with the current one, and the cache on disk
        //    stays the last good config.
        var problems = AgentConfigCheck.Problems(body.Config);
        if (problems.Count > 0)
        {
            _log.Warn($"Config {body.Version} refused — carrying on with the current one: {string.Join("; ", problems)}");
            return;
        }

        // Saved here, off the tracking thread; applied by TrackLoop as before
        if (_configFile is not null &&
            !_configFile.TrySave(new CachedAgentConfig
            {
                Version = body.Version,
                ReceivedAt = DateTimeOffset.UtcNow,
                Config = body.Config,
            }))
        {
            _log.Warn($"Config {body.Version} could not be saved — the next boot without network starts on the defaults");
        }

        Interlocked.Exchange(
            ref _pendingConfig, new PendingConfig(body.Config, body.Version));
    }

    /// <summary>
    /// What the agent knows about its own parts right now — the verdicts are
    /// in <see cref="CapabilityReport"/>, where they can be tested.
    /// ⚠️ Called from the heartbeat thread; every field read here is either
    ///    written atomically or a plain bool set once.
    /// </summary>
    private CapabilityFacts CapabilityFactsNow() => new()
    {
        IdleProbeFailStreak = Volatile.Read(ref _idleFailStreak),
        AppTrackingEnabledByPolicy = _config.AppTracking.Enabled,
        AppTrackerRunning = _apps is not null,
        BrowserDomainGaveUp = _apps?.UrlReadingDisabled == true,
        ScreenshotsEnabledByPolicy = _config.Screenshot.IsEnabled,
        ScreenshotFailStreak = Volatile.Read(ref _screenshotFailStreak),
        ScreenFingerprintFailed = _screenSampleFailing,
        Sync = _worker?.Health ?? SyncHealth.Ok,
    };

    /// <summary>The fetched config; <see cref="TrackLoop"/> picks it up.</summary>
    private sealed record PendingConfig(AgentConfig Config, string Version);

    /// <summary>
    /// Careful: <b>may only be called from <see cref="TrackLoop"/>.</b>
    ///
    /// Each change is examined separately, because none of them is free: changing the idle
    /// threshold means closing the current segment, and turning app tracking off means closing the
    /// open record. The rule is to leave anything unchanged alone, otherwise just saving the config
    /// on the server would needlessly cut everyone's segments.
    /// </summary>
    private void ApplyConfig(AgentConfig cfg, string version, DateTimeOffset now)
    {
        var old = _config;
        var change = ConfigChange.Between(old, cfg);

        _config = cfg;
        _configVersion = version;

        var changes = new List<string>();

        if (change.CaptureWindow)
        {
            _window = cfg.ToCaptureWindow();
            changes.Add($"capture window {old.ScreenshotFrom}–{old.ScreenshotTo} → {cfg.ScreenshotFrom}–{cfg.ScreenshotTo}");
        }

        // Careful: the current slot finishes as it was; the new size applies from the next
        // calculation. Changing midway would capture that slot's image twice, or not at all.
        if (change.Slots)
        {
            _slots = new SlotScheduler(cfg.SlotMinutes);
            changes.Add($"slot {old.SlotMinutes}m → {cfg.SlotMinutes}m");
        }

        // read by CaptureSlotAsync at every slot — nothing to rebuild, only to log
        if (old.Screenshot.IsEnabled != cfg.Screenshot.IsEnabled)
        {
            changes.Add(cfg.Screenshot.IsEnabled
                ? "screenshots on"
                : "screenshots off by policy (screen sampling for the jiggler check continues)");
        }

        if (change.Heartbeat)
        {
            changes.Add($"heartbeat {old.HeartbeatSec}s → {cfg.HeartbeatSec}s");
        }

        ApplyWorkZone(cfg, changes);

        ApplyAppTracking(cfg, old, change, now, changes);
        ApplyIdleThreshold(cfg, old, change, now, changes);

        // What changed must be in the log: if someone's hours suddenly look different, the first
        // question will be "did the config change?".
        _log.Info(changes.Count == 0
            ? $"Config {version} — nothing changed"
            : $"Config {version} applied: {string.Join(" · ", changes)}");
    }

    /// <summary>
    /// The work-day zone, when the server sends one (<c>utcOffsetMinutes</c>).
    ///
    /// ⚠️ A server older than the field sends nothing — the current zone stays.
    /// ⚠️ Applied before the idle and app trackers below, so a segment cut by
    /// those changes already gets the new work date.
    /// </summary>
    private void ApplyWorkZone(AgentConfig cfg, List<string> changes)
    {
        if (cfg.UtcOffsetMinutes is not { } minutes) return;

        var before = WorkTime.ToMemoryLine();
        if (!WorkTime.TrySet(cfg.Timezone, minutes))
        {
            _log.Warn($"Ignoring work-day zone {cfg.Timezone} ({minutes} min) — out of range");
            return;
        }

        if (WorkTime.ToMemoryLine() == before) return;

        _zoneMemory.Remember();
        changes.Add($"work-day zone {before} → {WorkTime.ToMemoryLine()}");
    }

    private void ApplyAppTracking(
        AgentConfig cfg, AgentConfig old, ConfigChange change,
        DateTimeOffset now, List<string> changes)
    {
        if (!change.AppTrackingToggled && !change.AppMinDuration) return;

        var wasOn = _apps is not null;
        var wantsOn = cfg.AppTracking.Enabled;

        // Careful: on shutdown the open record must be closed and queued, otherwise that time would
        // be lost silently.
        if (wasOn && !wantsOn)
        {
            RecordApps(_apps!.CloseAll(now));
            _apps = null;
            changes.Add("app tracking off");
            return;
        }

        if (!wasOn && wantsOn)
        {
            _apps = new AppUsageService(
                TimeSpan.FromSeconds(cfg.AppTracking.MinDurationSec));
            changes.Add("app tracking on");
            return;
        }

        if (wasOn && change.AppMinDuration)
        {
            RecordApps(_apps!.CloseAll(now));
            _apps = new AppUsageService(
                TimeSpan.FromSeconds(cfg.AppTracking.MinDurationSec));
            changes.Add($"app min {old.AppTracking.MinDurationSec}s → {cfg.AppTracking.MinDurationSec}s");
        }
    }

    /// <summary>
    /// Careful: the most sensitive change; this is where hours can be lost.
    ///
    /// The threshold goes into the <see cref="IdleStateMachine"/> constructor, so changing it needs
    /// a new object. <b>Before</b> that, the current segment is closed and queued; otherwise the
    /// time that was open inside the old machine would land in no segment, and nobody would notice.
    ///
    /// Careful: the new machine starts with <b>the old one's last state</b>. If it assumed the
    /// default <c>Active</c>, a person at a locked screen would count as "working" for one tick.
    /// </summary>
    private void ApplyIdleThreshold(
        AgentConfig cfg, AgentConfig old, ConfigChange change,
        DateTimeOffset now, List<string> changes)
    {
        if (!change.IdleThreshold || _machine is null) return;

        /**
         * <b>Closing and replacing happen under the same lock</b> (G160). They used to be separate,
         * and if <c>OnPower</c> arrived exactly in between, it opened a segment in the
         * <b>discarded</b> machine. That never reached the queue, yet the new machine's first
         * segment also starts at <c>now</c>, giving two rows for the same time.
         */
        IReadOnlyList<ActivitySegment> closed;

        lock (_machineGate)
        {
            var state = _machine.State;
            closed = _machine.CloseAll(now);
            _machine = new IdleStateMachine(
                TimeSpan.FromSeconds(cfg.IdleThresholdSec), now, state);
        }

        Record(closed);

        changes.Add($"idle {old.IdleThresholdSec}s → {cfg.IdleThresholdSec}s");
    }
}
