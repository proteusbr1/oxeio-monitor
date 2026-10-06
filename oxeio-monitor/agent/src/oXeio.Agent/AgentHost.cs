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
internal sealed class AgentHost : IAsyncDisposable
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

        // ── Identity and token ───────────────────────────────────────────────
        var identity = MachineIdentity.Collect();
        var tokenStore = new DeviceTokenStore(log: _log.Info);
        _credentials = DeviceCredentials.Open(tokenStore, identity, _log.Info);

        // ── Talking to the server ────────────────────────────────────────────
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

        // ── Offline queue ─────────────────────────────────────────────────────
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

        // ── the last good config (kept across reboots) ───────────────────
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

        // ── Tracking ─────────────────────────────────────────────────────────
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

        // ── tray ──────────────────────────────────────────────────────────────
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

    // ── Loops ────────────────────────────────────────────────────────────

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

    /// <summary>
    /// Careful: 1 = window is open. <see cref="EnrollIfNeededAsync"/> (startup) and the tray's
    /// "Sign in..." are two separate paths, and both can be called at the same time. Without this
    /// guard, two sign-in windows would open side by side, each sitting on a 12-hour timeout.
    /// </summary>
    private int _signInOpen;

    /// <summary>
    /// From the tray's "Sign in...": open the window <b>again</b>.
    ///
    /// Careful: the window used to appear only once, at startup. If it was closed, the only way
    /// back was to log off and on again, while the screen said in large text <i>"Sign in to start
    /// counting your hours"</i>. The task was announced but there was no door to do it.
    /// </summary>
    /// <summary>
    /// Careful: 1 = the confirmation window is open. Clicking the menu repeatedly would open
    /// several windows, each trying to clear the queue separately.
    /// </summary>
    private int _signOutOpen;

    /// <summary>
    /// From the tray's "Sign out": delete the token and return the machine to the "nobody signed
    /// in" state.
    ///
    /// Careful: <b>the order is the real decision here: sign out first, then clear the queue.</b>
    /// Reversed, in the moment between the two the tracking loop would still be running (the staff
    /// member is still enrolled), so a new row could slip in and stay in the queue after sign-out.
    /// When the next person signed in it would go out under <b>their</b> token. With sign-out
    /// first, <see cref="TrackingGate"/> stops new rows immediately.
    ///
    /// Careful: still not perfect. A <b>leased</b> row present at that exact moment is missed by
    /// this sweep (<c>EvictAsync</c> deliberately does not touch leased rows). The window is small
    /// but real, so after clearing, the depth is measured again and any remainder is logged
    /// <b>loudly</b>, not silently.
    /// </summary>
    private async Task SignOutOnDemandAsync()
    {
        if (_credentials is null || _outbox is null) return;

        var tray = _tray;
        if (tray is null) return;

        if (Interlocked.CompareExchange(ref _signOutOpen, 1, 0) != 0)
        {
            _log.Info("The sign-out confirmation is already open");
            return;
        }

        try
        {
            var depth = await _outbox.GetDepthAsync(_stopping.Token);

            // Careful: the same rule applies when the tray menu is drawn, but with the status
            // number (slightly stale). After the click, verify **again** with the real number,
            // otherwise a revoke arriving while the menu is open would still allow sign-out on a
            // revoked device.
            var verdict = SignOutGate.Check(
                _credentials.IsEnrolled, _credentials.IsRevoked, depth.Total);

            if (!SignOutGate.Allows(verdict))
            {
                _log.Info($"Sign out is not available right now ({verdict})");
                return;
            }

            if (!await ConfirmSignOutAsync(tray, SignOutGate.Confirm(verdict, depth.Total)))
            {
                _log.Info("Sign out cancelled by the user");
                return;
            }

            _credentials.SignOut("staff chose Sign out from the tray menu");

            var discarded = await DiscardOutboxAsync();
            if (discarded > 0)
                _log.Info($"Discarded {discarded} unsent item(s) so they cannot be counted for the next person");

            var left = await _outbox.GetDepthAsync(_stopping.Token);
            if (left.Total > 0)
            {
                // Careful: this cannot be swallowed silently: a remaining row means the next
                // person's record may get wrong hours.
                _log.Error(
                    $"⚠ {left.Total} item(s) were still leased and could not be discarded at sign-out. "
                    + "They may upload under the next person who signs in on this PC.");
            }

            tray.UpdateOptions(BuildTrayOptions());
            PublishStatus();
        }
        catch (OperationCanceledException)
        {
            // The agent is shutting down. An incomplete sign-out does no harm, because the token
            // was never deleted.
        }
        catch (Exception ex)
        {
            _log.Error("Sign out failed", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _signOutOpen, 0);
        }
    }

    /// <summary>
    /// Careful: it must be shown on the UI thread, via <see cref="TrayIcon.Post"/>, just like the
    /// sign-in window. A MessageBox raised from a background thread would sit outside the tray's
    /// message loop and could get lost behind other windows.
    ///
    /// The default button is <b>No</b>: this window's "Yes" deletes data, so pressing Enter by
    /// mistake should not be cheap.
    /// </summary>
    private static Task<bool> ConfirmSignOutAsync(TrayIcon tray, string message)
    {
        var completion = new TaskCompletionSource<bool>();

        tray.Post(() =>
        {
            try
            {
                var answer = MessageBox.Show(
                    message,
                    "oXeio — sign out",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2);

                completion.TrySetResult(answer == DialogResult.Yes);
            }
            catch (Exception)
            {
                // Careful: if the question could not even be asked, it counts as "No". The opposite
                // would let a UI glitch silently delete someone's data.
                completion.TrySetResult(false);
            }
        });

        return completion.Task;
    }

    /// <summary>
    /// Drops every <b>non-leased</b> row in the queue, files included: <c>EvictAsync</c> also
    /// deletes the .webp files and writes the reason to the drop-log, so the question "what was
    /// lost" can be answered later.
    /// </summary>
    private async Task<int> DiscardOutboxAsync()
    {
        if (_outbox is null) return 0;

        var entries = await _outbox.SurveyAsync(_stopping.Token);
        var rowIds = entries.Where(e => !e.Leased).Select(e => e.RowId).ToList();
        if (rowIds.Count == 0) return 0;

        return await _outbox.EvictAsync(rowIds, "sign out", _stopping.Token);
    }

    /**
     * <b>H04: run the verified MSI.</b>
     *
     * Careful: <b>not silent, and cannot be silent.</b> The agent runs with the logged-in user's
     * rights (<c>Group=Users</c> in the installer), and <c>msiexec</c> needs admin, so the UAC
     * window will always appear. "Install quietly in the background" would need a service running
     * as SYSTEM, which is a separate and bigger decision.
     *
     * And this mandatory click is not a bad thing: per G58, once a bad MSI runs there is no way
     * back. One person's consent is the last barrier against that risk.
     *
     * Careful: <c>/qb</c>, not silent (<c>/qn</c>). The staff member should see that something is
     * happening; if it ran silently the agent would stop for a few seconds and they would think
     * something broke.
     */
    private void InstallStagedUpdate()
    {
        var update = _updates?.Status;

        // Careful: verify again. The state can change after the menu is drawn (a new check ran, the
        // file was deleted). The tray's condition cannot be trusted.
        if (update is null || update.Stage != UpdateStage.Verified) return;

        var msi = update.MsiPath;
        if (string.IsNullOrWhiteSpace(msi) || !File.Exists(msi))
        {
            _log.Warn("Update was ready but the file is gone — it will be downloaded again.");
            return;
        }

        try
        {
            _log.Info($"Staff started the update to {update.Version}.");

            // Careful: UseShellExecute = true, otherwise the UAC elevation prompt would never
            // appear and the install would fail silently.
            Process.Start(new ProcessStartInfo
            {
                FileName = "msiexec.exe",
                Arguments = MsiArguments(msi, _settings.UpdatePublicKey),
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            // Careful: this is also reached when the staff member cancels (clicks "No" on UAC).
            // That is not an error, so it is only logged, not an Error.
            _log.Warn($"The update did not start: {ex.Message}");
        }
    }

    /// <summary>
    /// ⚠️ UPDATEKEY is passed on: msiexec rewrites the registry from the MSI's
    ///    properties, so a key given on the command line at first install would
    ///    otherwise be wiped by the first update — and with it the signature
    ///    check, silently. (An MSI built with the key baked in keeps it anyway.)
    /// </summary>
    internal static string MsiArguments(string msi, string? updatePublicKey) =>
        string.IsNullOrWhiteSpace(updatePublicKey) || updatePublicKey.Contains('"')
            ? $"/i \"{msi}\" /qb"
            : $"/i \"{msi}\" /qb UPDATEKEY=\"{UpdateSignature.OneLine(updatePublicKey)}\"";

    private async Task SignInOnDemandAsync()
    {
        if (_credentials is null || _sync is null) return;

        // Careful: if already signed in, return quietly. The menu item is hidden then, but if the
        // startup sign-in succeeds while the menu is open, the click could still arrive.
        if (!_credentials.NeedsEnrollment) return;

        if (Interlocked.CompareExchange(ref _signInOpen, 1, 0) != 0)
        {
            _log.Info("The sign-in window is already open");
            return;
        }

        try
        {
            var enroller = new EnrollmentClient(
                _sync, new DeviceTokenStore(log: _log.Info), _credentials, _version, _log.Info);

            await SignInAsync(enroller, MonitorEnumerator.Enumerate().Count, _stopping.Token);
        }
        catch (Exception ex)
        {
            _log.Error("The sign-in window could not be opened", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _signInOpen, 0);
        }
    }

    private async Task EnrollIfNeededAsync(CancellationToken ct)
    {
        if (_credentials is null || _sync is null) return;
        if (!_credentials.NeedsEnrollment) return;

        // Careful: the startup path is under the same guard, otherwise a window clicked from the
        // tray and this one could open together.
        if (Interlocked.CompareExchange(ref _signInOpen, 1, 0) != 0) return;

        try { await EnrollCoreAsync(ct); }
        finally { Interlocked.Exchange(ref _signInOpen, 0); }
    }

    private async Task EnrollCoreAsync(CancellationToken ct)
    {
        if (_credentials is null || _sync is null) return;

        var enroller = new EnrollmentClient(
            _sync,
            new DeviceTokenStore(log: _log.Info),
            _credentials,
            _version,
            _log.Info);

        var monitors = MonitorEnumerator.Enumerate().Count;

        /**
         * <b>Two paths, and the order is the main decision.</b>
         *
         * If a code was supplied at install time (scripted rollout, 15 PCs at once), it comes
         * first: nobody is at the keyboard then.
         *
         * Careful: with no code, it used to **shout into the void**: "No enrolment code - this
         * device has not been added to the server". The agent ran and tracked but sent nothing, and
         * nobody noticed, because the message went to a log that was not yet being written (H08).
         * Now the staff member is asked directly instead.
         */
        if (!string.IsNullOrWhiteSpace(_settings.EnrollmentCode))
        {
            var byCode = await enroller.EnrollWithRetryAsync(
                new SecretText(_settings.EnrollmentCode), monitors, ct: ct);

            _log.Info(byCode.Ok ? "✅ Device enrolled" : $"Enrolment failed: {byCode.Message}");
            PublishStatus();
            return;
        }

        await SignInAsync(enroller, monitors, ct);
    }

    /// <summary>
    /// Ask the staff member. The window is <see cref="SignInForm"/>.
    ///
    /// Careful: it <b>must run on the UI thread</b>. This method is called from the startup
    /// background task, and calling <c>ShowDialog()</c> directly from there would make WinForms
    /// either throw or put the window on a thread with no message loop of its own: the window would
    /// be visible but respond to no clicks.
    ///
    /// Careful: if the window is closed (or cancelled), the agent **keeps running**; it just does
    /// not enroll. It asks again at the next logon. If someone is in a hurry on install day they
    /// can start working, and that is correct.
    /// </summary>
    private async Task SignInAsync(EnrollmentClient enroller, int monitors, CancellationToken ct)
    {
        var tray = _tray;
        if (tray is null)
        {
            _log.Error("The sign-in window could not be opened — the tray is not up yet");
            return;
        }

        var completion = new TaskCompletionSource<EnrollmentResult?>();

        tray.Post(() =>
        {
            try
            {
                using var form = new SignInForm(
                    _settings.ServerUrl,
                    (email, password, totp, token) =>
                        enroller.SignInAsync(email, password, totp, monitors, token));

                form.ShowDialog();
                completion.TrySetResult(form.Result);
            }
            catch (Exception ex)
            {
                _log.Error("The sign-in window could not be opened", ex);
                completion.TrySetResult(null);
            }
        });

        /**
         * <b>A timeout exists, and it must.</b> `Post()` never throws and returns nothing: if the
         * handle has been destroyed it quietly drops the work. This `await` would then hang
         * **forever**, and the startup task with it.
         */
        EnrollmentResult? result;
        try
        {
            result = await completion.Task
                .WaitAsync(TimeSpan.FromHours(12), ct)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // the window was left open all day; nobody sat down
            _log.Warn("The sign-in window was left open all day — this PC is still not enrolled");
            return;
        }
        catch (OperationCanceledException)
        {
            // the agent is shutting down
            return;
        }

        _log.Info(result is null
            ? "Sign-in was closed without enrolling — this PC is not sending anything yet"
            : result.Ok
                ? "✅ Device enrolled by sign-in"
                : $"Sign-in failed: {result.Message}");

        PublishStatus();
    }

    // ── Config (E09, K07) ────────────────────────────────────────────────

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

        // ── Image time window (A04b): just a reference swap ─────────────────
        if (change.CaptureWindow)
        {
            _window = cfg.ToCaptureWindow();
            changes.Add($"capture window {old.ScreenshotFrom}–{old.ScreenshotTo} → {cfg.ScreenshotFrom}–{cfg.ScreenshotTo}");
        }

        // ── Slot (A01) ────────────────────────────────────────────────────
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

        var before = DhakaTime.ToMemoryLine();
        if (!DhakaTime.TrySet(cfg.Timezone, minutes))
        {
            _log.Warn($"Ignoring work-day zone {cfg.Timezone} ({minutes} min) — out of range");
            return;
        }

        if (DhakaTime.ToMemoryLine() == before) return;

        _zoneMemory.Remember();
        changes.Add($"work-day zone {before} → {DhakaTime.ToMemoryLine()}");
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

    /// <summary>
    /// H04: check for a new version once every 6 hours.
    ///
    /// Careful: if this loop fails, updates do not arrive, but neither time counting nor sync
    /// stops. No failure here may reach tracking.
    /// </summary>
    private async Task UpdateLoopAsync(CancellationToken ct)
    {
        if (_updates is null) return;

        // Careful: not right at startup. Let enrollment and the first heartbeat happen first;
        // checking without a token would only get a 401.
        try { await Task.Delay(TimeSpan.FromMinutes(2), ct); }
        catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            if (_credentials?.IsEnrolled == true)
            {
                await _updates.CheckOnceAsync(ct);
                PublishStatus();
            }

            try { await Task.Delay(UpdateStager.CheckEvery, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    public async Task SyncNowAsync()
    {
        if (_worker is null) return;
        await _worker.DrainOnceAsync(_stopping.Token);
        PublishStatus();
    }

    // ── State ────────────────────────────────────────────────────────────

    private void Record(IReadOnlyList<ActivitySegment> closed)
    {
        foreach (var s in closed)
        {
            if (s.CountsAsWork)
            {
                // today's count resets at Dhaka midnight (section 2.1)
                var date = DhakaTime.WorkDateOf(s.StartedAt);
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

    // ── Events (G02) ─────────────────────────────────────────────────────

    /// <summary>
    /// Puts an <see cref="AgentEventRecord"/> <b>on the queue</b>, not on the network.
    ///
    /// <b>That is the whole reason for this method.</b> Goodbye events (logoff, shutdown,
    /// agent_stop) are created exactly when Windows has about 2 seconds left for all processes
    /// combined. An HTTP call at that moment could hang on DNS or TCP, Windows would kill the
    /// process, and the event would be <b>lost</b>: the event the whole system exists for would be
    /// the one most likely to vanish. Queuing is a SQLite insert of a few dozen microseconds;
    /// sending is done by DisposeAsync's final drain or the next startup.
    ///
    /// Careful: it is not <c>await</c>ed, because the caller may be the UI thread (WM_ENDSESSION).
    /// <see cref="SqliteOutboxStore.EnqueueAsync"/> uses <c>ConfigureAwait(false)</c> inside, so
    /// the real write goes to the thread pool and the desktop is not blocked.
    /// </summary>
    private Task RaiseEvent(string type, IReadOnlyDictionary<string, object?>? meta = null) =>
        RaiseEvent(new AgentEventRecord
        {
            ClientUuid = Guid.NewGuid(),
            Type = type,
            OccurredAt = DateTimeOffset.UtcNow,
            Meta = meta,
        });

    /// <returns>A task that completes when the disk write is done; the goodbye path waits on
    /// it.</returns>
    private Task RaiseEvent(AgentEventRecord record)
    {
        if (_outbox is null) return Task.CompletedTask;

        // Careful: no events before sign-in either; the rule is "nothing goes out", not partial.
        // These are all goodbye events (agent_stop, logoff, shutdown), so a machine that never
        // signed in would pile up exactly one row, but it would go out under **someone's** name if
        // they signed in later.
        //
        // Careful: also dropped on revoke: the token is deleted, so the row could never reach the
        // server and would only grow the outbox (same reasoning as StopTrackingForRevoke).
        if (!TrackingGate.Allows(
                _credentials?.IsEnrolled == true,
                _credentials?.IsRevoked == true))
        {
            return Task.CompletedTask;
        }

        var queued = _outbox.EnqueueAsync(OutboxCodec.Item(record, DateTimeOffset.UtcNow));

        queued.ContinueWith(
            t => _log.Error($"Could not queue the event ({record.Type})", t.Exception),
            TaskContinuationOptions.OnlyOnFaulted);

        // R29-B: the write is **returned**, so the goodbye path can know whether the row really
        // reached the disk.
        //
        // Careful: failure is swallowed here (the `ContinueWith` above reports it). The caller puts
        // this in `WaitAsync`, and if a failed task threw there, a needless exception would rise at
        // the moment of goodbye.
        //
        // Careful: **no field chain is kept**, on purpose. The first draft had `_pendingEnqueue =
        // Task.WhenAll(previous, ...)`, which looks harmless, but it lengthened the chain with
        // every event and no task could ever be collected. With thousands of events a day that is a
        // **memory leak**. The goodbye path only waits for **its own two** writes, and it can hold
        // those by hand.
        return queued.ContinueWith(static _ => { }, TaskScheduler.Default);
    }

    /// <summary>
    /// The body of <c>agent_stop</c>. It is built from both paths (WM_ENDSESSION and DisposeAsync),
    /// so it lives in one place; otherwise one day one path would set <c>reason</c> and the other
    /// would not, and the server would suspect that machine.
    /// </summary>
    private AgentEventRecord BuildStopEvent() => new()
    {
        ClientUuid = Guid.NewGuid(),
        Type = AgentEventTypes.AgentStop,
        OccurredAt = DateTimeOffset.UtcNow,
        Meta = new Dictionary<string, object?>
        {
            ["agentVersion"] = _version,

            // Careful: the only clue to why it is stopping. "unknown" means neither logoff nor
            // shutdown arrived; the server will then treat it as suspicious, which is the intent.
            ["reason"] = ClosingReason(),
        },
    };

    /// <summary>
    /// A goodbye event: once in a lifetime.
    ///
    /// Careful: once <c>shutdown</c> is recorded, a later <c>logoff</c> is suppressed. When Windows
    /// shuts down, the session's logoff broadcast also arrives, but it is one event: the PC is
    /// shutting down. Writing two rows would make the log read as if the staff member logged off
    /// first and then someone shut down the PC.
    /// </summary>
    /// <returns>Whether it was actually queued.</returns>
    private bool RaiseClosingEvent(string type, IReadOnlyDictionary<string, object?>? meta = null) =>
        RaiseClosingEvent(type, out _, meta);

    /// <param name="queued">
    /// The task for the disk write to finish (R29-B). Careful: if the event is dropped it is
    /// <see cref="Task.CompletedTask"/>, so the caller does not have to handle `null`.
    /// </param>
    private bool RaiseClosingEvent(
        string type,
        out Task queued,
        IReadOnlyDictionary<string, object?>? meta = null)
    {
        queued = Task.CompletedTask;
        if (!TryMarkClosing(type)) return false;

        queued = RaiseEvent(type, meta);
        _log.Info($"Event queued: {type}");
        return true;
    }

    /// <summary>Is this the first time for this goodbye event? If so, marks it.</summary>
    private bool TryMarkClosing(string type)
    {
        lock (_closingEventsSent)
        {
            if (_closingEventsSent.Contains(type)) return false;

            if (type == AgentEventTypes.Logoff &&
                _closingEventsSent.Contains(AgentEventTypes.Shutdown))
            {
                return false;
            }

            _closingEventsSent.Add(type);
            return true;
        }
    }

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

    // ── Window messages (from the UI thread) ─────────────────────────────

    /// <summary>
    /// The raw code of <c>WM_WTSSESSION_CHANGE</c>.
    ///
    /// Careful: the code itself is taken, not the interpreted <see cref="SessionChange"/>. For
    /// tracking, lock and logoff are the same (both suspend), but for G02 they are completely
    /// different: one is "they will come back", the other "they have gone". Interpreting first
    /// would stop that difference from reaching here.
    /// </summary>
    public void OnSessionChange(int wtsCode)
    {
        var change = SessionMonitor.Interpret(wtsCode);

        if (change == SessionChange.Suspend) _sessionSuspended = true;
        else if (change == SessionChange.Resume) _sessionSuspended = false;

        if (SessionMonitor.ClosingEventType(wtsCode) is { } type)
        {
            RaiseClosingEvent(type, new Dictionary<string, object?>
            {
                // Careful: only the code and its name; no username, hostname or window text (the
                // rule of AgentEventRecord.Meta).
                ["source"] = "wts",
                ["wtsCode"] = wtsCode,
            });
        }
    }

    /// <summary>
    /// <c>WM_ENDSESSION</c>: whether it is a logoff or a PC shutdown is known right here.
    /// <see cref="SessionMonitor.InterpretEndSession"/> explains why not PowerMonitor.
    /// </summary>
    public void OnSessionEnd(string? eventType)
    {
        if (eventType is null) return;

        if (!RaiseClosingEvent(eventType, out var closingQueued, new Dictionary<string, object?>
            {
                ["source"] = "endsession",
            }))
        {
            return;
        }

        // <b>agent_stop is queued right here, not left to DisposeAsync.</b> WM_ENDSESSION means the
        // session really is ending; after it Windows kills the process, and whether
        // <c>Application.Run()</c> returns at all depends on WinForms internals. If it did not
        // return, DisposeAsync would never run, and on every normal shutdown the server would get
        // logoff/shutdown but no agent_stop: exactly the opposite gap.
        //
        // There is no fear of queuing twice: if DisposeAsync runs, TryMarkClosing stops it.
        var stopQueued = TryMarkClosing(AgentEventTypes.AgentStop)
            ? RaiseEvent(BuildStopEvent())
            : Task.CompletedTask;

        // R29-B: and the attempt to **send** happens right here.
        TryFlushGoodbye(closingQueued, stopQueued);
    }

    /// <summary>
    /// <b>R29-B: the last chance to send the goodbye event now.</b>
    ///
    /// After <c>WM_ENDSESSION</c> Windows kills the process, and there is no guarantee that
    /// <c>Application.Run()</c> returns. Field numbers say it does <b>not</b> return on an OS
    /// shutdown (the delay averages 740 minutes, meaning sending happens at the next startup). So
    /// we cannot rely on <c>DisposeAsync</c>'s priority drain; this is the last place where we are
    /// still alive.
    ///
    /// Careful: <b>the UI thread waits here, and that is this method's only risk.</b> It is bounded
    /// in three ways:
    /// <list type="bullet">
    /// <item>The work runs in <c>Task.Run</c>, on the thread pool, without the UI's
    /// <c>SynchronizationContext</c>. Careful: calling <c>.Wait()</c> directly would be a classic
    /// deadlock: the continuation would want the UI thread, and the UI thread is waiting.</item>
    /// <item>The total ceiling is <see cref="EndSessionSendBudget"/>, less than half of Windows'
    /// <c>WaitToKillAppTimeout</c> (default 5 s).</item>
    /// <item>On failure nothing is lost: the event stays in the outbox and the next startup sends
    /// it. <b>Worst case = today's behaviour.</b></item>
    /// </list>
    ///
    /// Careful: <c>ShutdownBlockReasonCreate</c> is not used, although the roadmap (R29-B) said to.
    /// It tells Windows "wait": the user sees an "oXeio is blocking shutdown" screen, and if it is
    /// released wrongly the desktop hangs. Here only a few hundred milliseconds are needed, and
    /// those are available without asking; trying the cheap path before taking an OS-level block is
    /// the right order.
    /// </summary>
    private void TryFlushGoodbye(params Task[] queued)
    {
        var worker = _worker;
        if (worker is null) return;

        var flush = Task.Run(async () =>
        {
            // Step 1: let the rows queued at this moment reach the disk
            try { await Task.WhenAll(queued).WaitAsync(EndSessionEnqueueWait); }
            catch (Exception) { /* the write did not finish; try sending anyway */ }

            // Step 2: Event only, not segments or images.
            // Careful: `DrainOnceAsync` runs Segment then Event, so with a backlog the goodbye
            // would never get time. There is a single kind here.
            using var cts = new CancellationTokenSource(EndSessionSendBudget);
            await worker.DrainKindOnceAsync(OutboundKind.Event, cts.Token);
        });

        // Careful: exceptions are swallowed. An exception thrown at the moment of goodbye would
        // reach WndProc and drop the process messily, leaving `agent_stop` sitting in the outbox:
        // exactly what this code is meant to prevent.
        try
        {
            if (!flush.Wait(EndSessionTotalBudget))
            {
                _log.Info("Goodbye send did not finish in time — the outbox keeps it");
            }
        }
        catch (Exception ex)
        {
            _log.Error("Goodbye send failed — the outbox keeps it", ex);
        }
    }

    /// <summary>
    /// The reason sent with <c>agent_stop</c>: <c>shutdown</c>, <c>logoff</c> or <c>unknown</c>.
    ///
    /// Careful: <c>unknown</c> is not covered up. "Someone killed the process" versus "the PC shut
    /// down" is the entire point of G02. When in doubt, the doubt stays in the record.
    /// </summary>
    private string ClosingReason()
    {
        lock (_closingEventsSent)
        {
            if (_closingEventsSent.Contains(AgentEventTypes.Shutdown))
                return AgentEventTypes.Shutdown;

            if (_closingEventsSent.Contains(AgentEventTypes.Logoff))
                return AgentEventTypes.Logoff;

            // Stopping for an update is also a **known** reason, not "unknown". Careful: without
            // the reason, the event would forever say "who knows why it stopped", although we knew
            // exactly.
            if (_closingEventsSent.Contains(AgentEventTypes.AgentUpdate))
                return AgentEventTypes.AgentUpdate;
        }

        return "unknown";
    }

    public void OnPower(PowerSignal? signal)
    {
        /**
         * Careful: <b>this method runs on the UI (message pump) thread</b>, not the tracker thread:
         * <c>Program.OnMessage</c> calls it directly. This was the real path behind G160: at the
         * moment the screen went to sleep, this thread and the tracker thread both entered the same
         * machine.
         *
         * Careful: <b>deliberately not deferred.</b> Leaving it like <c>_pendingConfig</c> for the
         * tracker to do would be wrong here: on a real <c>PBT_APMSUSPEND</c> the PC sleeps within
         * about 2 seconds and the tracker no longer ticks, so the open segment would be closed
         * after waking and the whole sleep would count as work. That is exactly the <b>G3</b> bug
         * that <see cref="IdleStateMachine.OnSuspend"/> was written to prevent.
         */
        IReadOnlyList<ActivitySegment>? closed = null;

        if (signal is PowerSignal.Suspend or PowerSignal.DisplayOff)
        {
            // About 2 seconds are left before sleep: only close the segment, no network calls.
            lock (_machineGate) closed = _machine?.OnSuspend(_clock.Now);
            _sleep.Reset();
        }
        else if (signal == PowerSignal.Resume)
        {
            lock (_machineGate) closed = _machine?.OnResume(_clock.Now);
            _sleep.Reset();
        }

        // Careful: **outside** the lock: this writes to SQLite (see `_machineGate` above)
        if (closed is not null) Record(closed);
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

        // ── G02: agent_stop ───────────────────────────────────────────────────
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

        // ── G136: goodbye events first ────────────────────────────────────────
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
