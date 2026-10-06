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

/// <summary>Agent updates: checking for, staging and installing a new MSI.</summary>
internal sealed partial class AgentHost
{
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
}
