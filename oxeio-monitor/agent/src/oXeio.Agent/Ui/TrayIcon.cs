using System.Diagnostics;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Core.Agent;
using oXeio.Core.Time;

namespace oXeio.Agent.Ui;

/// <summary>
/// The tray icon: the only visible part of the agent.
///
/// <b>This is not decoration, it is a compliance surface.</b> The written monitoring policy
/// promises staff that the icon will always be visible. So if this class does not work
/// properly the installation becomes covert, which we have said we will not do. Therefore:
///
///  - There is no way to hide <see cref="NotifyIcon.Visible"/>, and it is set to true again
///    on every render (even if someone hid it by mistake from code, it returns within a second).
///  - The menu has <b>no Exit</b>. Staff cannot stop the agent from the tray.
///  - The menu has no break/meeting/pause button (ADR-011d). Anything staff can press
///    would be the first step of an approval workflow, and this system has nothing like that.
///
/// Careful: the thread that creates this object must also call <c>Application.Run()</c>
/// later. <see cref="Publish"/> can be called from any thread.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TrayIcon : IAgentStatusSink, IDisposable
{
    private const string BalloonTitle = "oXeio";

    // The two states of the sync menu item. Kept as constants because the text appears in two
    // places (at creation and in RefreshMenu); written by hand, one would change and not the other.
    private const string SyncNowText = "Sync now";
    private const string SyncBusyText = "Syncing…";

    /// <summary>Within this window, pressing "Sync now" again sends no new request.</summary>
    private static readonly TimeSpan SyncDebounce = TimeSpan.FromSeconds(20);

    private readonly MonotonicClock _clock;
    private readonly UiDispatcher _dispatcher;
    private readonly TrayIconPainter _painter;
    private readonly TrayFonts _fonts;
    private readonly BalloonThrottle _balloons;

    private readonly NotifyIcon _notify;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _updateItem;
    private readonly ToolStripMenuItem _signInItem;
    private readonly ToolStripMenuItem _signOutItem;
    private readonly ToolStripMenuItem _todayItem;
    private readonly ToolStripMenuItem _portalItem;
    private readonly ToolStripMenuItem _policyItem;
    private readonly ToolStripMenuItem _syncItem;
    private readonly ToolStripMenuItem _aboutItem;

    // ── touched only from the UI thread ───────────────────────────────────
    private TrayOptions _options;
    private AgentStatus _status = AgentStatus.Starting;
    private TrayVisual? _shownVisual;
    private string? _shownText;
    private SyncHealth? _shownHealth;

    /// <summary>
    /// Which version has already been announced: once per version.
    ///
    /// Careful: <see cref="BalloonThrottle"/>'s hourly throttle is not enough here: a verified
    /// update can sit for days (if staff do not install it), and one balloon an hour means
    /// eight a day; after that the app would get silenced in Windows, and the urgent
    /// sync-failure message would be lost too.
    ///
    /// Careful: the slot is emptied when the agent restarts, so there is one reminder the next
    /// day. That is deliberate; an update not yet installed is worth a reminder.
    /// </summary>
    private string? _notifiedUpdate;
    private TimeSpan? _lastSyncRequest;
    private TodayForm? _todayForm;
    private AboutForm? _aboutForm;

    // ── crosses threads ───────────────────────────────────────────────────
    private AgentStatus _pending = AgentStatus.Starting;
    private int _renderScheduled;
    private volatile bool _disposed;

    public TrayIcon(TrayOptions options, MonotonicClock? clock = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        _options = options;
        _clock = clock ?? MonotonicClock.StartNow();
        _dispatcher = new UiDispatcher(options.OnError);
        _painter = new TrayIconPainter();
        _fonts = new TrayFonts();
        _balloons = new BalloonThrottle();

        // At the very top, and **bold** when not signed in: in that state everything else in the
        // window (hours, image, sync) is meaningless, and only one task is left.
        /**
         * H04: the only way to install a new version, and it is **in the staff's hands**.
         *
         * Careful: the name ends with "…": pressing it brings up the UAC window, so there is
         * still time to think. Nothing happens silently.
         */
        _updateItem = new ToolStripMenuItem("Install update…") { Visible = false };
        _signInItem = new ToolStripMenuItem("Sign in…") { Visible = false };

        // Careful: no "…" at the end of the name, deliberately. "…" means "another window will
        // come, there is still time to think", but here the window only confirms; it is not a
        // new task.
        _signOutItem = new ToolStripMenuItem("Sign out") { Visible = false };
        _todayItem = new ToolStripMenuItem("Today's hours");
        _portalItem = new ToolStripMenuItem("My data");
        _policyItem = new ToolStripMenuItem("View policy");
        _syncItem = new ToolStripMenuItem(SyncNowText);
        _aboutItem = new ToolStripMenuItem("About");

        _updateItem.Click += (_, _) => Guarded(() => _options.InstallUpdate?.Invoke());
        _signInItem.Click += (_, _) => Guarded(() => _options.RequestSignIn?.Invoke());
        _signOutItem.Click += (_, _) => Guarded(() => _options.RequestSignOut?.Invoke());
        _todayItem.Click += (_, _) => Guarded(ShowToday);
        _portalItem.Click += (_, _) => Guarded(() =>
            OpenExternal(_options.StaffPortalUrl, "No staff portal address is configured"));
        _policyItem.Click += (_, _) => Guarded(() =>
            OpenExternal(_options.PolicyUrl, "Policy document not found"));
        _syncItem.Click += (_, _) => Guarded(RequestSync);
        _aboutItem.Click += (_, _) => Guarded(ShowAbout);

        _menu = new ContextMenuStrip
        {
            Font = _fonts.Get(TrayFontRole.Body, _dispatcher.Dpi),
            ShowImageMargin = false,
        };

        _menu.Items.AddRange(new ToolStripItem[]
        {
            // At the very top: when a new version arrives it is the most urgent job right now
            _updateItem,
            _signInItem,
            _todayItem,
            _portalItem,
            _policyItem,
            new ToolStripSeparator(),
            _syncItem,
            _aboutItem,
            new ToolStripSeparator(),
            _signOutItem,
        });

        // Careful: do not add an "Exit" item here. If added, staff could stop their own
        // tracking, and the 208-hour accounting would mean nothing.
        //
        // Careful: **"Sign out" is not an exception to that prohibition; it is a different
        // thing**, and the difference is in three places:
        //      1. "Exit" stops **silently**: the office sees the machine quiet and cannot tell
        //         it apart from the PC being off.
        //      2. Sign out deletes the token, so not a single further row can go under that
        //         person's name: the tally is **not ambiguous, it is finished**.
        //      3. On a shared PC this is the only honest way. Without it the next person's
        //         hours would go onto the previous person's record, which is exactly what we
        //         want to avoid.
        //    So the item is **at the very bottom, after a separator**, not beside the
        //    everyday items, so that it is not pressed by mistake.

        _menu.Opening += (_, _) => Guarded(RefreshMenu);

        // Careful: there is a specific reason to use WinForms's NotifyIcon instead of calling
        // <c>Shell_NotifyIcon</c> by hand: when explorer.exe crashes and restarts, all tray
        // icons are wiped and the shell broadcasts a registered "TaskbarCreated" message. An
        // implementation that does not catch it loses its icon until the next reboot: invisible
        // exactly when nobody is looking.
        // NotifyIcon registers that message itself and brings the icon back.
        _notify = new NotifyIcon
        {
            ContextMenuStrip = _menu,
            Icon = _painter.Get(TrayVisual.Idle),
            Text = BalloonTitle,
            Visible = true,
        };

        _notify.DoubleClick += (_, _) => Guarded(ShowToday);

        // Set the first appearance now, without waiting for the first Publish
        Render(AgentStatus.Starting);
    }

    /// <summary>
    /// Run something on the UI thread: this is the route for anyone outside who needs this thread.
    ///
    /// Careful: there is **exactly one** <see cref="UiDispatcher"/> in the agent, and it is
    /// inside this class. A second one would sit on another thread (whichever it was created
    /// on), and then "UI thread" would mean two different things; in WinForms the penalty for
    /// that mistake does not come immediately, it comes once, about two weeks later.
    /// </summary>
    public void Post(Action action) => _dispatcher.Post(action);

    // ── IAgentStatusSink ──────────────────────────────────────────────────

    /// <summary>
    /// Comes from the tracking/sync thread. Never blocks, never throws.
    ///
    /// Careful: a separate <c>BeginInvoke</c> is not made for each update. If the UI thread
    /// stalled for a moment (menu open, a drag in progress), one message a second would pile up
    /// and the queue would bloat. Instead the latest status is kept and just one render stays
    /// queued; nobody would have seen the frames in between anyway.
    /// </summary>
    public void Publish(AgentStatus status)
    {
        if (status is null || _disposed) return;

        Volatile.Write(ref _pending, status);

        if (Interlocked.Exchange(ref _renderScheduled, 1) == 0)
            _dispatcher.Post(RenderPending);
    }

    /// <summary>To set the device id/employee name after enrollment.</summary>
    public void UpdateOptions(TrayOptions options)
    {
        if (options is null || _disposed) return;

        _dispatcher.Post(() =>
        {
            _options = options;
            _aboutForm?.RedrawContent();
            _todayForm?.Invalidate();
        });
    }

    // ── render (always on the UI thread) ──────────────────────────────────

    private void RenderPending()
    {
        // Careful: lower the flag first, then read the value. The other way round, an update
        // arriving between those two steps would be lost and the icon would stay stuck in the
        // old state forever.
        Interlocked.Exchange(ref _renderScheduled, 0);
        Render(Volatile.Read(ref _pending));
    }

    private void Render(AgentStatus status)
    {
        if (_disposed) return;

        _status = status;

        var visual = TrayVisuals.For(status);
        if (_shownVisual != visual)
        {
            _shownVisual = visual;

            // Careful: set only when it changes. Setting the same icon every second makes the
            // shell redraw the tray each time; on some machines that flickers visibly.
            _notify.Icon = _painter.Get(visual);
        }

        var text = TrayTooltip.Build(status);
        if (!string.Equals(_shownText, text, StringComparison.Ordinal))
        {
            _shownText = text;
            SetTooltip(text);
        }

        // Policy: the icon must not be hidden
        if (!_notify.Visible) _notify.Visible = true;

        NotifyOnHealthChange(status);
        NotifyOnMonthlyTarget(status);
        NotifyOnUpdateReady(status);

        _todayForm?.Apply(status);
    }

    /// <summary>
    /// Careful: <see cref="NotifyIcon.Text"/> must never be allowed to throw. On older
    /// runtimes more than 63 characters raises <c>ArgumentOutOfRangeException</c>, and that
    /// would happen here on the UI thread, stopping the whole agent just because "the text was
    /// a bit long". <see cref="TrayTooltip"/> already measures it; this is the second net.
    /// </summary>
    private void SetTooltip(string text)
    {
        try
        {
            _notify.Text = text;
            return;
        }
        catch (ArgumentException)
        {
        }

        try
        {
            // Last resort: a raw cut. This risks splitting a character, because the
            // alternative is an icon with no tooltip.
            _notify.Text = text.Length > TrayTooltip.MaxLength
                ? text[..TrayTooltip.MaxLength]
                : text;
        }
        catch (ArgumentException)
        {
            try { _notify.Text = BalloonTitle; }
            catch (ArgumentException) { }
        }
    }

    // ── balloons ──────────────────────────────────────────────────────────

    private void NotifyOnHealthChange(AgentStatus status)
    {
        var previous = _shownHealth;
        if (previous == status.Health) return;

        _shownHealth = status.Health;

        // No balloon on the first render: there is no need to announce "all is well" at startup,
        // and it would suppress a real problem's balloon for an hour
        if (previous is null) return;

        switch (status.Health)
        {
            case SyncHealth.Failing:
                Balloon("sync_failing", TrayTooltip.SyncFailingLine, ToolTipIcon.Warning);
                break;

            case SyncHealth.Revoked:
                Balloon("revoked", TrayTooltip.RevokedLine, ToolTipIcon.Warning);
                break;

            case SyncHealth.Ok when previous is SyncHealth.Failing or SyncHealth.Degraded:
                Balloon("sync_restored", "Connection to the server is back", ToolTipIcon.Info);
                break;
        }
    }

    /// <summary>
    /// J03: once, ✅ when this month's target is reached.
    ///
    /// Important: <b>it is remembered before showing, not after.</b> Showing a balloon is a
    /// task that can fail silently (Focus Assist, notifications off); if memory depended on its
    /// success, that machine would try again on every heartbeat, and a flood of balloons would
    /// come the moment Focus Assist was turned off.
    ///
    /// Careful: there is deliberately no "before/after render" comparison here. The target can
    /// be reached even while the agent was off (the employee worked on another PC), and then
    /// the condition is already true at the first heartbeat; checking "did it change" would mean
    /// that employee never gets the balloon.
    /// </summary>
    private void NotifyOnMonthlyTarget(AgentStatus status)
    {
        var memory = _options.Milestone;
        if (memory is null) return;

        if (!MonthlyMilestone.ShouldCelebrate(
                status, DateTimeOffset.UtcNow, memory.LastCelebrated(), out var monthKey))
        {
            return;
        }

        memory.Remember(monthKey);
        Balloon(
            MonthlyMilestone.EventClass,
            MonthlyMilestone.Text(status.MonthlyTargetHours),
            ToolTipIcon.Info);
    }

    /// <summary>
    /// <b>H04: an update is ready, and staff are told.</b>
    ///
    /// Careful: <b>nothing used to be said.</b> The new version downloaded and verified
    /// silently, and "Install update…" appeared in the menu, but unless someone opened the tray
    /// menu there was no way to know. Sync failure, revoked device and the monthly target all
    /// had balloons; the update did not.
    ///
    /// So the owner had to go to every PC and install by hand, even though the MSI was already
    /// verified and sitting on that machine.
    ///
    /// Careful: the message says <b>what to do</b>, not just "an update exists"; without saying
    /// where the menu is, the message would remain a question.
    /// </summary>
    private void NotifyOnUpdateReady(AgentStatus status)
    {
        var update = status.Update;

        // Careful: only Verified, not while downloading or verifying, exactly the menu's
        // condition. Telling staff earlier, they would open the menu and find nothing.
        if (update.Stage != UpdateStage.Verified) return;

        var version = update.Version;
        if (string.IsNullOrWhiteSpace(version)) return;

        // Careful: no install path, stay quiet; otherwise the message would ask for something
        // that cannot be done
        if (_options.InstallUpdate is null) return;

        if (string.Equals(_notifiedUpdate, version, StringComparison.Ordinal)) return;

        // Remembered **before** showing: a balloon can fail silently (Focus Assist), and if
        // memory depended on its success every render would try again (same reasoning as in
        // NotifyOnMonthlyTarget).
        _notifiedUpdate = version;

        Balloon(
            "update_ready",
            $"Update {version} is ready — right-click the oXeio tray icon and choose “Install update”.",
            ToolTipIcon.Info);
    }

    /// <summary>
    /// Careful: the timeout parameter has been ignored since Windows Vista; the system now
    /// decides how long it is shown. Careful: when Focus Assist is on or the user has turned
    /// notifications off, this silently does nothing, with no error, so a balloon can never be
    /// the only messenger; the icon and tooltip are the primary channel.
    /// </summary>
    private void Balloon(string eventClass, string text, ToolTipIcon icon)
    {
        if (string.IsNullOrEmpty(text)) return;
        if (!_balloons.ShouldShow(eventClass, _clock.Elapsed)) return;

        try
        {
            _notify.ShowBalloonTip(10_000, BalloonTitle, text, icon);
        }
        catch (Exception ex)
        {
            Report(ex);
        }
    }

    // ── menu actions ──────────────────────────────────────────────────────

    private void RefreshMenu()
    {
        // Careful: Visible, not Enabled. Once signed in the item has no further meaning; hanging
        // around greyed out would make staff think something is broken.
        /**
         * Careful: only in the <c>Verified</c> stage, not while downloading or verifying.
         *
         * In <c>Offered</c>/<c>Downloaded</c> the file is not yet trustworthy, and in
         * <c>Corrupt</c> it has already been deleted. Showing the button in those states would
         * have staff press it, nothing would happen, and they would think the system is broken.
         */
        _updateItem.Visible =
            _status.Update.Stage == UpdateStage.Verified
            && _options.InstallUpdate is not null;

        if (_updateItem.Visible)
            _updateItem.Text = $"Install update {_status.Update.Version}…";

        _signInItem.Visible = !_status.Enrolled && _options.RequestSignIn is not null;

        /*
         * Careful: the decision is not made here; it comes from <see cref="SignOutGate"/>, and
         * <c>AgentHost</c> re-checks it after the click. Writing two different conditions in two
         * places would show the item and then do nothing when pressed.
         *
         * The tray does not have to read the outbox; <c>QueueDepth</c> is already in the status.
         */
        _signOutItem.Visible =
            _options.RequestSignOut is not null
            && SignOutGate.Allows(
                _status.Enrolled,
                _status.Health == SyncHealth.Revoked,
                _status.QueueDepth);

        _portalItem.Enabled = !string.IsNullOrWhiteSpace(_options.StaffPortalUrl);
        _policyItem.Enabled = !string.IsNullOrWhiteSpace(_options.PolicyUrl);

        var busy = _options.RequestSyncNow is null ||
                   (_lastSyncRequest is { } last && _clock.Elapsed - last < SyncDebounce);

        _syncItem.Enabled = !busy;
        _syncItem.Text = busy && _lastSyncRequest is not null ? SyncBusyText : SyncNowText;
    }

    private void ShowToday()
    {
        if (_todayForm is { IsDisposed: false } existing)
        {
            existing.Activate();
            return;
        }

        var form = new TodayForm(_fonts, () => _options);
        form.FormClosed += (_, _) => _todayForm = null;

        _todayForm = form;
        form.Apply(_status);
        form.Show();
        form.PositionNearTray();
        form.Activate();
    }

    private void ShowAbout()
    {
        if (_aboutForm is { IsDisposed: false } existing)
        {
            existing.Activate();
            return;
        }

        var form = new AboutForm(_fonts, () => _options);
        form.FormClosed += (_, _) => _aboutForm = null;

        _aboutForm = form;
        form.Show();
        form.PositionNearTray();
        form.Activate();
    }

    private void RequestSync()
    {
        var request = _options.RequestSyncNow;
        if (request is null) return;

        var now = _clock.Elapsed;
        if (_lastSyncRequest is { } last && now - last < SyncDebounce) return;

        _lastSyncRequest = now;

        // Careful: sync must not be called on the UI thread. If the implementation sat in an
        // HTTP call, the tray would freeze meanwhile, and staff would think the agent had
        // crashed, just when they are worried about the connection.
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try { request(); }
            catch (Exception ex) { Report(ex); }
        });

        Balloon("sync_now", "Sync started", ToolTipIcon.Info);
    }

    // ── external links ────────────────────────────────────────────────────

    private void OpenExternal(string? target, string missingMessage)
    {
        if (string.IsNullOrWhiteSpace(target) || !TryResolveTarget(target, out var launch))
        {
            Balloon("link_missing", missingMessage, ToolTipIcon.Warning);
            return;
        }

        try
        {
            // Careful: UseShellExecute explicitly true. In .NET Core its default is false, and
            // then giving a URL raises a Win32Exception "The specified executable is not a valid
            // application"; this is not caught unless you test on a local machine.
            using var process = Process.Start(new ProcessStartInfo(launch)
            {
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Report(ex);
            Balloon("link_failed", "Couldn't open the link", ToolTipIcon.Warning);
        }
    }

    /// <summary>Only http/https, or a file with one of <see cref="AllowedDocumentExtensions"/>.</summary>
    private static bool TryResolveTarget(string target, out string launch)
    {
        launch = string.Empty;

        if (Uri.TryCreate(target, UriKind.Absolute, out var uri))
        {
            if (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            {
                launch = uri.AbsoluteUri;
                return true;
            }

            return uri.IsFile && TryResolveFile(uri.LocalPath, out launch);
        }

        return TryResolveFile(target, out launch);
    }

    /// <summary>
    /// Careful: this allow-list is the real security. The policy address comes from config,
    /// and config comes over the network. Without validation before ShellExecute, changing that
    /// one string would let any <c>.exe</c>, <c>.lnk</c>, <c>.hta</c> or <c>.ps1</c> run in the
    /// staff member's account; the monitoring agent itself would be the easiest attack path.
    /// </summary>
    private static readonly string[] AllowedDocumentExtensions =
        [".pdf", ".html", ".htm", ".md", ".txt", ".rtf", ".docx"];

    private static bool TryResolveFile(string path, out string launch)
    {
        launch = string.Empty;

        try
        {
            var full = Path.GetFullPath(path);
            if (!File.Exists(full)) return false;

            var extension = Path.GetExtension(full);
            foreach (var allowed in AllowedDocumentExtensions)
            {
                if (string.Equals(extension, allowed, StringComparison.OrdinalIgnoreCase))
                {
                    launch = full;
                    return true;
                }
            }

            return false;
        }
        catch (Exception ex) when (
            ex is ArgumentException or NotSupportedException or
                  PathTooLongException or IOException or UnauthorizedAccessException or
                  System.Security.SecurityException)
        {
            return false;
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private void Guarded(Action action)
    {
        try
        {
            if (!_disposed) action();
        }
        catch (Exception ex)
        {
            Report(ex);
        }
    }

    private void Report(Exception ex)
    {
        try { _options.OnError?.Invoke(ex); }
        catch { /* if even the logger is broken there is nothing more to do */ }
    }

    // ── shutdown ──────────────────────────────────────────────────────────

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        // Careful: not directly, but posted to the UI thread. Disposing a NotifyIcon/Form from
        // another thread destroys the handle on the wrong thread, and a ghost icon stays in the
        // tray until someone hovers the mouse over it.
        _dispatcher.Post(TearDown);
    }

    private void TearDown()
    {
        // The order is the real work:
        // 1) hide the icon: disposing without hiding leaves the entry with the shell, and a
        //    "ghost icon" remains
        // 2) Icon = null: otherwise the shell would try to draw the HICON destroyed in step 4
        // 3) close the windows
        // 4) the drawing resources
        try { _notify.Visible = false; } catch (Exception ex) { Report(ex); }
        try { _notify.Icon = null; } catch (Exception ex) { Report(ex); }

        try { _todayForm?.Close(); } catch (Exception ex) { Report(ex); }
        try { _aboutForm?.Close(); } catch (Exception ex) { Report(ex); }
        _todayForm = null;
        _aboutForm = null;

        try { _notify.Dispose(); } catch (Exception ex) { Report(ex); }
        try { _menu.Dispose(); } catch (Exception ex) { Report(ex); }

        try { _painter.Dispose(); } catch (Exception ex) { Report(ex); }
        try { _fonts.Dispose(); } catch (Exception ex) { Report(ex); }

        // Last of all: we got here through its handle
        try { _dispatcher.Dispose(); } catch (Exception ex) { Report(ex); }
    }
}
