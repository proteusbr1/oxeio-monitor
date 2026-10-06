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

/// <summary>
/// The full agent: every module is wired together here.
///
/// <b>Thread split:</b>
/// <list type="bullet">
/// <item>UI thread: tray icon and window messages (lock, power). Never blocked.</item>
/// <item>Tracker thread: reads idle state every second. Small and fast, no I/O.</item>
/// <item>Background tasks: capture, sync, heartbeat, app usage. Slow work lives only here.</item>
/// </list>
///
/// Important: <b>tracking never stops for the network or the disk.</b> If the server is down, the
/// disk is full or enrollment fails, the per-second counting keeps going and only uploading waits.
/// The opposite would let a network problem directly cut someone's pay.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed partial class AgentHost : IAsyncDisposable
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan SyncEvery = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How often the queue's disk budget is enforced.
    ///
    /// Careful: not on every sync cycle (30 s). The survey does a full table scan, and with a large
    /// queue that would spin the disk for nothing. Once an hour is enough: about 170 MB accumulates
    /// per day and the cap is 2 GiB. The exception is a failed write, which does not wait
    /// (`LastWriteError`).
    /// </summary>
    private static readonly TimeSpan BudgetSweepEvery = TimeSpan.FromHours(1);
    /// <summary>
    /// The heartbeat interval comes from the server config (<c>heartbeatSec</c>), clamped to a
    /// range.
    ///
    /// Careful: both a floor and a ceiling are needed. If someone set 1 second by mistake, 15 PCs
    /// would send 1.3 million requests a day. If someone set 1 day, the "agent silent for 10
    /// minutes" alert would stay lit forever for every machine.
    /// </summary>
    private static readonly TimeSpan HeartbeatMin = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HeartbeatMax = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Maximum time to wait for <c>agent_stop</c> to be written to disk during shutdown. Careful:
    /// Windows' whole shutdown budget is a few seconds, and time must remain for the final drain.
    ///
    /// Important: lowered from 2 s to 0.5 s. This is the <b>first</b> step of
    /// <see cref="DisposeAsync"/>, and the three steps run in sequence: 2 + 2 + 1.5 = <b>5.5 s</b>,
    /// while <c>Program.ShutdownBudget</c> is 4. On a bad day the final full drain would <b>never
    /// start</b>, which is exactly what lowering <see cref="FinalDrainBudget"/> from 3 to 1.5 was
    /// meant to prevent.
    ///
    /// 0.5 s is not a guess: <see cref="EndSessionEnqueueWait"/> uses the same number for exactly
    /// the same work (one SQLite INSERT), so both shutdown paths give the same job the same budget.
    ///
    /// Careful: hitting the ceiling does not lose the event. <c>EnqueueAsync</c> keeps running in
    /// the background (<c>WaitAsync</c> only stops <b>waiting</b>, not the work), and the 3 seconds
    /// of the two drains below give it enough time to reach the disk.
    /// </summary>
    internal static readonly TimeSpan StopEnqueueBudget = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// Maximum time for the final drain before shutdown.
    /// Careful: this must stay within <c>Program.ShutdownBudget</c> (4 s). A larger value would
    /// mean the drain never stops on its own and the process is killed from outside.
    /// </summary>
    /// Careful: lowered from 3 to 1.5 s. <see cref="GoodbyeBudget"/> (2 s) had been added without
    /// reducing this, so the two summed to 5 s against a <c>Program.ShutdownBudget</c> of 4.
    /// <c>Shutdown()</c> would give up after 4 seconds and <b>the final full drain never got its
    /// whole time</b>. The condition was written in a comment but not enforced; now
    /// `ShutdownBudgetTests` catches it.
    internal static readonly TimeSpan FinalDrainBudget = TimeSpan.FromMilliseconds(1500);

    /// <summary>
    /// Budget for sending only the goodbye events, <b>before</b> the final full drain.
    ///
    /// The full drain <see cref="Sync.SyncWorker.DrainOnceAsync"/> always runs Segment then Event,
    /// so with a segment backlog the goodbye event could sit in the outbox without reaching the
    /// 3-second budget. This is kept small: event rows are tiny and go in half a second on a live
    /// link; on a dead link it stops after this short wait and leaves the time to the full drain
    /// (total ceiling <c>Program.ShutdownBudget</c>, 4 s).
    /// </summary>
    /// Careful: lowered from 2 to 1.5 s, for the same reason as <see cref="StopEnqueueBudget"/>
    /// above. The number is borrowed here too: <see cref="EndSessionSendBudget"/> uses 1.5 s for
    /// exactly this job (one small POST), and with a 5 ms ping on BDIX it is still a hundred times
    /// more than needed.
    internal static readonly TimeSpan GoodbyeBudget = TimeSpan.FromMilliseconds(1500);

    /// <summary>
    /// <b>Ceiling for sending the goodbye event inside <c>WM_ENDSESSION</c>.</b>
    ///
    /// Why it was needed, measured in the field: over the last 7 days <c>agent_stop</c> reached the
    /// server <b>on average 740 minutes late</b> (maximum 1127). All 48 had <c>reason:
    /// shutdown</c>, so the event was <b>captured</b> on time and queued; the whole delay was in
    /// <b>sending</b>. Shutting down at noon delivered it within a minute (the PC comes back on);
    /// shutting down in the evening delivered it the next morning, because sending happened at the
    /// <b>next startup</b>.
    ///
    /// A1 (0.4.7) added a priority drain to <c>DisposeAsync</c> and cut the delay from 2341 to 740
    /// minutes. But <c>DisposeAsync</c> only runs when <c>Application.Run()</c> returns, and on an
    /// OS shutdown it does not return. So the overnight case remained.
    ///
    /// An earlier comment here said <i>"trying to send would freeze the desktop"</i>. That was true
    /// when the server was in the USA with a 250 ms ping. Now the server is on BDIX with a <b>5 ms
    /// ping</b> (ADR-034), which changes the arithmetic: one small POST takes a few dozen
    /// milliseconds.
    ///
    /// Still, never without a <b>ceiling</b>. Windows' <c>WaitToKillAppTimeout</c> defaults to 5 s;
    /// we use less than half of it, and on failure the event stays in the outbox, so the worst case
    /// is <b>today's behaviour</b>.
    /// </summary>
    internal static readonly TimeSpan EndSessionSendBudget = TimeSpan.FromMilliseconds(1500);

    /// <summary>
    /// Inside the ceiling above: how long to wait for the queue write to finish. Careful:
    /// <see cref="RaiseEvent"/> is fire-and-forget, so without waiting the drain would look for a
    /// row that has not yet landed in SQLite.
    /// </summary>
    internal static readonly TimeSpan EndSessionEnqueueWait = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// The most the UI thread can be blocked in total: the sum of the two steps.
    ///
    /// Careful: this is a separate constant on purpose. The first draft used only
    /// <see cref="EndSessionSendBudget"/> as the outer ceiling, yet the inner work could take more
    /// than that across its two steps. If the write ran late there would be almost no time left for
    /// sending, and the ceiling would **measure something other than** what it claims to measure.
    /// </summary>
    internal static readonly TimeSpan EndSessionTotalBudget =
        EndSessionEnqueueWait + EndSessionSendBudget;

    private readonly AgentSettings _settings;
    private readonly string _version;
    private readonly ISyncLog _log;

    private readonly MonotonicClock _clock = MonotonicClock.StartNow();
    private readonly IdleProbe _idle = new();
    private readonly SleepGapDetector _sleep = new(Tick);
    private readonly CancellationTokenSource _stopping = new();

    private LivenessBeacon? _beacon;
    private SqliteOutboxStore? _outbox;
    private HttpSyncClient? _sync;
    private SyncWorker? _worker;
    private DeviceCredentials? _credentials;
    private TrayIcon? _tray;
    /// <summary>
    /// Careful: <b>several threads touch this field</b>. The tracker reads and writes it, the
    /// message pump (<see cref="OnPower"/>) replaces it, and the thread pool (<c>DisposeAsync</c>)
    /// shuts it down.
    ///
    /// <b>Two layers of protection</b>, and both are needed:
    /// <list type="bullet">
    ///   <item><see cref="IdleStateMachine"/> protects <b>its own internals</b>, when two threads
    ///   enter the same object;</item>
    ///   <item><see cref="_machineGate"/> protects <b>the reference</b>.
    ///   <see cref="ApplyIdleThreshold"/> discards the old object and installs a new one, and if
    ///   <c>OnPower</c> arrived in that gap it would write a segment into the <b>discarded</b>
    ///   object, overlapping the new one's first segment. The inner lock cannot catch that gap in
    ///   any way.</item>
    /// </list>
    /// </summary>
    private volatile IdleStateMachine? _machine;

    /// <summary>
    /// Lock for reading and replacing the <see cref="_machine"/> reference.
    ///
    /// Careful: <b>never call <see cref="Record"/> inside this lock.</b> <c>Record</c> writes to
    /// SQLite, and <c>OnPower</c> runs on the message pump, where Windows gives only about 2
    /// seconds before sleeping. Writing to disk under the lock would cause exactly the stall that
    /// <c>MessageWindow</c>'s own comment forbids. Rule: <b>mutate inside the lock, write outside
    /// it.</b>
    /// </summary>
    private readonly object _machineGate = new();
    private ScreenCaptureService? _capture;
    private SlotScheduler? _slots;
    private AppUsageService? _apps;
    private UpdateStager? _updates;
    private CaptureWindow _window = CaptureWindow.Default;

    /// <summary>How many 5-minute cells the tray shows: the last ~30 minutes.</summary>
    private const int BusyBlocks = 6;

    /// <summary>
    /// Careful: the tracking loop writes and the UI thread reads, hence the lock. <c>Queue</c> is
    /// not thread-safe, and a race here would throw while the window is being drawn.
    /// </summary>
    private readonly Queue<int> _recentBusy = new(BusyBlocks);
    private readonly object _busyGate = new();

    /// <summary>
    /// The config currently in effect. Careful: it starts as <see cref="AgentConfig.Default"/>,
    /// because tracking must not wait for the server's config to arrive.
    /// </summary>
    private AgentConfig _config = AgentConfig.Default;

    /// <summary>The last work-day zone, kept on disk across restarts.</summary>
    private readonly WorkZoneMemory _zoneMemory;

    /// <summary>
    /// Fetched from the server but not yet applied. The heartbeat thread writes it and
    /// <see cref="TrackLoop"/> picks it up with <c>Interlocked.Exchange</c>.
    /// </summary>
    private PendingConfig? _pendingConfig;

    /// <summary>The last good config on disk — <c>null</c> until <see cref="TryStart"/>.</summary>
    private AgentConfigFile? _configFile;

    /// <summary>When the budget was last enforced. Only the sync loop touches it.</summary>
    private DateTimeOffset _lastBudgetSweep = DateTimeOffset.MinValue;

    private volatile bool _sessionSuspended;
    private long _activeTodaySec;

    /// <summary>Revocation is logged once, not on every slot.</summary>
    private bool _revokeLogged;

    /// <summary>Whether tracking has been wound down once after a revocation.</summary>
    private bool _trackingStoppedForRevoke;

    /// <summary>Thumbnail of the last captured image, shown in the window.</summary>
    private string? _latestShotThumb;
    private DateTimeOffset? _latestShotAt;
    private int _latestShotMonitors;
    private DateOnly _activeDate;
    private EmployeeProgress? _progress;

    /// <summary>
    /// <b>When</b> today's counted figure was measured: the anchor for the window's running clock
    /// (<see cref="LiveDuration"/>). It is the heartbeat moment when the server's figure has
    /// arrived, otherwise the moment the last segment was counted. Careful: the two are kept
    /// separate because the anchor must match whichever figure <see cref="Snapshot"/> uses. Merging
    /// them would make the clock count from the wrong point.
    /// </summary>
    /// <summary>
    /// How far the server's total is **ahead of our own count**: the work done before this agent
    /// started (a reboot, or the first part of the day in another session). In each heartbeat we
    /// send our own <c>ActiveSecToday</c> and the server returns its total; the difference is this
    /// offset.
    ///
    /// Careful: without it, after a reboot the window would show either the server's **frozen**
    /// figure (seconds would not tick) or our own count starting from zero, losing the morning's
    /// work. Offset plus our own running count gives both correctly.
    /// </summary>
    private long _todayOffsetSec;
    private string? _configVersion;
    private MilestoneMemory? _milestone;

    /// <summary>
    /// Which goodbye events have already been queued.
    ///
    /// Careful: dedup is mandatory. On one logoff Windows reports <b>twice</b>, once via
    /// <c>WM_WTSSESSION_CHANGE</c> and once via <c>WM_ENDSESSION</c>. Sending both would put two
    /// rows for the same event on the server, and <c>agent_events</c> is an event log: writing
    /// twice means the event happened twice.
    /// </summary>
    private readonly HashSet<string> _closingEventsSent = new(StringComparer.Ordinal);

    public AgentHost(AgentSettings settings, string version, ISyncLog? log = null)
    {
        _settings = settings;
        _version = version;
        _log = log ?? NullSyncLog.Instance;

        // Before the first work date is computed: a restart without network
        // must keep counting in the zone the server last sent, not in Dhaka
        _zoneMemory = new WorkZoneMemory(AgentDataDirectory.Default);
        if (_zoneMemory.TryRestore())
            _log.Info($"Work-day zone restored: {DhakaTime.ToMemoryLine()}");

        _activeDate = DhakaTime.WorkDateOf(DateTimeOffset.UtcNow);
    }

    public TrayIcon? Tray => _tray;

    /// <summary>
    /// Must be called from the UI thread, because the tray icon is created here. Careful: returns
    /// <c>false</c> on failure, not an exception: the reason it could not start has to be shown to
    /// the staff member, not a stack trace.
    /// </summary>
    public bool TryStart(nint messageWindowHandle, out string? error)
    {
        error = null;

        var guard = SessionGuard.Check();
        if (!guard.CanTrack)
        {
            error = $"Time cannot be counted in this session — {guard.Explanation}";
            return false;
        }

        if (!AgentDataDirectory.TryEnsure(AgentDataDirectory.Default, out var dirError))
        {
            error = $"Could not create the data folder: {dirError}";
            return false;
        }

        // Take the lock first: if another agent is running, we must stop right here. Two agents on
        // one machine would count the same hour twice, and the server would only see "a lot of
        // work".
        _beacon = LivenessBeacon.TryAcquire(AgentDataDirectory.Default);
        if (_beacon is null)
        {
            error = "An oXeio agent is already running on this PC.";
            return false;
        }

        _beacon.Start();

        var identity = MachineIdentity.Collect();
        var tokenStore = new DeviceTokenStore(log: _log.Info);
        _credentials = DeviceCredentials.Open(tokenStore, identity, _log.Info);

        _sync = new HttpSyncClient(
            new SyncClientOptions
            {
                BaseAddress = _settings.ApiRoot,
                AgentVersion = _version,
                // If a pin is configured, we do the TLS verification ourselves
                ServerPin = _settings.ServerPin,
            },
            log: _log);
        _credentials.ApplyTo(_sync);
        _credentials.Changed += c => c.ApplyTo(_sync);

        // Download and verify the new version. Careful: it is **not** installed here, because that
        // is written in UpdateStage. (The paths are only available after the queue is open, so
        // installation happens below.)

        // Careful: the agent runs even if the queue cannot be opened. Time counting does not stop;
        // only sending is impossible, and that shows up red in the tray.
        try
        {
            _outbox = SqliteOutboxStore.Open(log: _log.Info);
            _worker = new SyncWorker(_outbox, _sync, _log);
            _updates = new UpdateStager(_sync, _outbox.Paths, _version, _log, _settings.UpdatePublicKey);
        }
        catch (Exception ex)
        {
            _log.Error("Could not open the offline queue — no data will be stored", ex);
        }

        // ⚠️ Before the tracking objects below are built from `_config`: a
        //    reboot while the server is unreachable must keep the policy the
        //    server last sent, not fall back to AgentConfig.Default. The
        //    version goes with it, so the first heartbeat only fetches a new
        //    config when the server's has actually changed.
        _configFile = new AgentConfigFile(AgentDataDirectory.Default);
        if (_configFile.TryLoad() is { } cached)
        {
            _config = cached.Config;
            _configVersion = cached.Version;
            _log.Info($"Config {cached.Version} restored from disk (received {cached.ReceivedAt:yyyy-MM-dd HH:mm}Z)");
        }
        else
        {
            _log.Info("No saved config — starting on the defaults until the server answers");
        }

        var lockState = LockStateProbe.Query();
        _machine = new IdleStateMachine(
            TimeSpan.FromSeconds(_config.IdleThresholdSec),
            _clock.Now,
            lockState == LockState.Locked ? SegmentState.Locked : SegmentState.Active);

        _capture = new ScreenCaptureService(
            new FallbackCapturer(new DuplicationCapturer(), new GdiCapturer()));
        _slots = new SlotScheduler(_config.SlotMinutes);
        _window = _config.ToCaptureWindow();

        // Careful: if disabled in the config, the object is not created at all. That way the
        // foreground window name never enters memory either, rather than just "not being sent".
        if (_config.AppTracking.Enabled)
        {
            _apps = new AppUsageService(
                TimeSpan.FromSeconds(_config.AppTracking.MinDurationSec));
        }

        // Remembers which month the balloon was shown for. Careful: created once here, because
        // passing a new object to UpdateOptions would lose the cache.
        _milestone = new MilestoneMemory(AgentDataDirectory.Default);

        _tray = new TrayIcon(BuildTrayOptions());
        _tray.Publish(Snapshot());

        _ = messageWindowHandle; // session/power registration happens in Program

        StartLoops();
        return true;
    }

    private TrayOptions BuildTrayOptions() => new()
    {
        AgentVersion = _version,
        ServerUrl = _settings.ServerUrl,
        DeviceId = _credentials?.DeviceId,
        EmployeeName = _credentials?.Employee?.FullName,
        EmpCode = _credentials?.Employee?.EmpCode,
        StaffPortalUrl = _settings.StaffPortalUrl,
        PolicyUrl = _settings.PolicyUrl,
        RequestSyncNow = () => _ = SyncNowAsync(),
        RequestSignIn = () => _ = SignInOnDemandAsync(),
        RequestSignOut = () => _ = SignOutOnDemandAsync(),
        InstallUpdate = InstallStagedUpdate,
        Milestone = _milestone,
        OnError = ex => _log.Error("tray", ex),
    };

    private void StartLoops()
    {
        var tracker = new Thread(TrackLoop)
        {
            IsBackground = true,
            Name = "oXeio-tracker",
            Priority = ThreadPriority.BelowNormal,
        };
        tracker.Start();

        _ = Task.Run(() => CaptureLoopAsync(_stopping.Token));
        _ = Task.Run(() => AppUsageLoopAsync(_stopping.Token));
        _ = Task.Run(() => SyncLoopAsync(_stopping.Token));
        _ = Task.Run(() => HeartbeatLoopAsync(_stopping.Token));
        _ = Task.Run(() => EnrollIfNeededAsync(_stopping.Token));
        _ = Task.Run(() => UpdateLoopAsync(_stopping.Token));
    }

    public async Task SyncNowAsync()
    {
        if (_worker is null) return;
        await _worker.DrainOnceAsync(_stopping.Token);
        PublishStatus();
    }

    public async ValueTask DisposeAsync()
    {
        await _stopping.CancelAsync();

        // Careful: G160: cancelling `_stopping` does not mean the tracker has stopped; it checks
        // the token only at the top of the `while`, so right now it can well be mid-tick.
        IReadOnlyList<ActivitySegment>? lastSegments;
        lock (_machineGate) lastSegments = _machine?.CloseAll(_clock.Now);
        if (lastSegments is not null) Record(lastSegments);
        if (_apps is not null) RecordApps(_apps.CloseAll(_clock.Now));

        // This is the only input to the server's tamper alert. With a logoff/shutdown beside it the
        // server says "normal stop", without one "interference" (alerts.rules.ts). So both must be
        // sent.
        //
        // Careful: it awaits here, on purpose: for the final drain below to catch the event, it
        // must already be in SQLite. If fire-and-forget, it could lose the race and sit until the
        // next startup, and in the uninstall case the next startup would never come.
        //
        // Careful: still <b>not the network</b>, only the disk, and even that has a ceiling. The
        // ceiling is via WaitAsync, not via EnqueueAsync's CancellationToken: SqliteOutboxStore
        // deliberately ignores that token (to avoid half-written rows), so passing it would let us
        // believe a ceiling existed when in reality nothing would stop. Careful: this path
        // **bypasses** `RaiseEvent()` (it calls EnqueueAsync directly, because a time budget
        // applies here), so the gate is needed here separately too. This is exactly how
        // AppUsageLoop was missed at first.
        if (_outbox is not null
            && TrackingGate.Allows(
                _credentials?.IsEnrolled == true,
                _credentials?.IsRevoked == true)
            && TryMarkClosing(AgentEventTypes.AgentStop))
        {
            try
            {
                await _outbox
                    .EnqueueAsync(OutboxCodec.Item(BuildStopEvent(), DateTimeOffset.UtcNow))
                    .WaitAsync(StopEnqueueBudget);
            }
            catch (Exception ex)
            {
                _log.Error("Could not queue the agent_stop event", ex);
            }
        }

        // shutdown/logoff + agent_stop are sent **before everything else**.
        //
        // Careful: the full drain below runs Segment then Event (SyncWorker.Order). On a PC that
        // shuts down at night, the last ~30 seconds of segments are still in the queue, and if the
        // 3-second budget ran out on those, the goodbye event would stay behind. The next day the
        // server would see "the last message was not a goodbye" and raise a false agent_down
        // (isExpectedSilence in alerts.rules.ts). That was the root of the morning wall of stale
        // warnings.
        //
        // Careful: even on failure/timeout the event **stays** in the outbox (the full drain below
        // or the next startup picks it up), so this is purely a best-effort priority with no
        // regression. The network is safe here: DisposeAsync is not on the UI thread;
        // Program.Shutdown awaits it on the thread pool.
        if (_worker is not null)
        {
            using var goodbye = new CancellationTokenSource(GoodbyeBudget);
            try { await _worker.DrainKindOnceAsync(OutboundKind.Event, goodbye.Token); }
            catch (Exception) { /* shutting down */ }
        }

        // Last attempt: send the rest (segments, images) before shutting down.
        //
        // Careful: the ceiling used to be 10 seconds, but it was never reached: Program.Shutdown()
        // stops the whole DisposeAsync after 4 seconds (Windows' own budget is even smaller). With
        // 10, the drain would never be cancelled; the process would be killed midway, with an HTTP
        // call half done. Now it steps aside first, so no cut-off request reaches the server.
        if (_worker is not null)
        {
            using var last = new CancellationTokenSource(FinalDrainBudget);
            try { await _worker.DrainOnceAsync(last.Token); }
            catch (Exception) { /* shutting down; nothing more to do */ }
        }

        _beacon?.Dispose();
        _tray?.Dispose();
        _capture?.Dispose();
        _sync?.Dispose();
        if (_outbox is not null) await _outbox.DisposeAsync();
        _stopping.Dispose();
    }
}
