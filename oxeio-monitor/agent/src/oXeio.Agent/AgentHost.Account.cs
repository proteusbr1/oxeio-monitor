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

/// <summary>Signing in and out, and enrolling this PC.</summary>
internal sealed partial class AgentHost
{
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
}
