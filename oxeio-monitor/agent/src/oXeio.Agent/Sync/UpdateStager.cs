using System.Security.Cryptography;

using oXeio.Agent.Storage;
using oXeio.Core.Agent;

namespace oXeio.Agent.Sync;

/// <summary>
/// Finding a new version, downloading it, verifying it. <b>Not installing it.</b>
///
/// The reason for not installing is written in <see cref="UpdateStage"/>; in short:
/// [G58](../../../../docs/history/08-Gap-Analysis.md). Once a bad MSI has run, it cannot be rolled
/// back with a new MSI; someone has to go to the machine by hand.
/// </summary>
internal sealed class UpdateStager(
    ISyncClient sync,
    OutboxPaths paths,
    string currentVersion,
    ISyncLog log,
    string? updatePublicKey = null)
{
    /// <summary>
    /// The owner's update key, if this PC has one (<see cref="UpdateSignature"/>).
    /// </summary>
    private readonly ECDsa? _updateKey = UpdateSignature.ParsePublicKey(updatePublicKey);

    /// <summary>
    /// ⚠️ A key is configured but cannot be read. Fail closed: treating it as
    ///    "no key" would turn the protection off without anyone noticing.
    /// </summary>
    private bool KeyUnreadable =>
        !string.IsNullOrWhiteSpace(updatePublicKey) && _updateKey is null;

    /// <summary>
    /// Careful: not often. Updates are not an everyday event, and each check is a network
    /// call; 15 PCs x many times a day would be needless crowding. Once every 6 hours is
    /// enough, because installing is in human hands anyway.
    /// </summary>
    public static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);

    private UpdateStatus _status = UpdateStatus.Idle;

    public UpdateStatus Status => _status;

    /// <summary>
    /// One look. Exceptions never escape; not getting an update is an inconvenience, but not
    /// a reason to stop tracking.
    /// </summary>
    public async Task CheckOnceAsync(CancellationToken ct)
    {
        try
        {
            var result = await sync.CheckUpdateAsync(currentVersion, ct).ConfigureAwait(false);

            // Careful: on failure the previous state is **not erased**. If the server were down
            // for an hour, an MSI that was already verified would become "gone", and the
            // owner would see the update vanish.
            if (!result.IsSuccess || result.Value is not { } offer) return;

            if (string.IsNullOrWhiteSpace(offer.Version)) return;

            // M2: the version becomes a file name and a URL parameter; only strict SemVer may.
            // Careful: the previous state is left alone here too. A malformed offer is the
            // server's (or an attacker's) problem, not a reason to forget a verified MSI.
            if (!SemVer.IsValid(offer.Version))
            {
                log.Error(
                    $"⛔ Update offer refused — the version is not a plain version number: " +
                    $"\"{Printable(offer.Version)}\". Nothing was downloaded.");
                return;
            }

            // L2: never the same or an older version (SemVer.IsNewer says why)
            if (!SemVer.IsNewer(offer.Version, currentVersion))
            {
                log.Warn(
                    $"Update offer {offer.Version} refused — this PC already runs {currentVersion}. " +
                    "The server never offers that; a replayed or forged offer would.");
                return;
            }

            // This version is already verified and waiting; no point downloading again
            if (_status.Stage == UpdateStage.Verified && _status.Version == offer.Version)
                return;

            await StageAsync(offer, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            log.Error("Could not check for updates — it will be retried later", ex);
        }
    }

    private async Task StageAsync(UpdateOffer offer, CancellationToken ct)
    {
        _status = new UpdateStatus
        {
            Stage = UpdateStage.Offered,
            Version = offer.Version,
            Mandatory = offer.Mandatory,
        };

        // M2: checked again where the path is made, not only where the offer arrived, so this
        // method can never be called one day with an unchecked version.
        var destination = UpdateFiles.MsiPathFor(paths.Updates, offer.Version);
        if (destination is null)
        {
            log.Error($"⛔ Update {Printable(offer.Version)} refused — its file name would leave {paths.Updates}.");
            _status = _status with { Stage = UpdateStage.Corrupt, Detail = "bad version" };
            return;
        }

        Directory.CreateDirectory(paths.Updates);

        var download = await sync.DownloadUpdateAsync(offer.Version, destination, ct)
                                 .ConfigureAwait(false);

        if (!download.IsSuccess || download.Value is not { } file)
        {
            log.Warn($"Could not download update {offer.Version}: {download.Detail}");
            _status = _status with { Stage = UpdateStage.Offered, Detail = download.Detail };
            return;
        }

        _status = _status with { Stage = UpdateStage.Downloaded, MsiPath = file.SavedPath };

        // This is the only real security check here. What the server said and what arrived
        // on disk must match; if they do not, the file must not be run, and must not even be
        // kept, or someone might later install it thinking it was fine.
        if (!string.Equals(file.Sha256, offer.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            log.Error(
                $"⛔ The hash of update {offer.Version} does not match — " +
                $"expected {offer.Sha256}, got {file.Sha256}. The file is being deleted.");

            TryDelete(file.SavedPath);

            _status = _status with
            {
                Stage = UpdateStage.Corrupt,
                MsiPath = null,
                Detail = "sha256 mismatch",
            };
            return;
        }

        // the owner's signature — only when this PC has the owner's key
        var signature = KeyUnreadable
            ? SignatureCheck.Invalid
            : UpdateSignature.Verify(_updateKey, file.Sha256, offer.Signature);

        if (signature is SignatureCheck.Missing or SignatureCheck.Invalid)
        {
            var why = KeyUnreadable
                ? "the UpdatePublicKey on this PC cannot be read"
                : signature == SignatureCheck.Missing
                    ? "the server sent no signature"
                    : "the signature does not match the owner's key";

            log.Error(
                $"⛔ Update {offer.Version} refused — {why}. The hash matched, but only " +
                "the owner's key proves who made the file. The file is being deleted.");

            TryDelete(file.SavedPath);

            _status = _status with
            {
                Stage = UpdateStage.Corrupt,
                MsiPath = null,
                Detail = signature == SignatureCheck.Missing ? "signature missing" : "signature invalid",
            };
            return;
        }

        _status = _status with { Stage = UpdateStage.Verified };
        log.Info(
            $"✅ Update {offer.Version} verified" +
            (signature == SignatureCheck.Valid ? " (hash and owner's signature)" : "") +
            $" — waiting to be installed: {file.SavedPath}");

        // Downloaded MSIs of older versions are no longer needed
        CleanOldMsi(file.SavedPath);
    }

    /// <summary>
    /// A server-supplied string, safe for one log line: control characters (a forged
    /// <c>\r\n</c> would fake a second log entry) are replaced and the length is capped.
    /// </summary>
    internal static string Printable(string? text)
    {
        if (text is null) return "";
        var clipped = text.Length > 80 ? text[..80] + "…" : text;
        return string.Concat(clipped.Select(c => char.IsControl(c) ? '?' : c));
    }

    private void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.Warn($"Could not delete the corrupt MSI — {path}: {ex.Message}");
        }
    }

    /// <summary>
    /// Careful: each version's MSI is ~62 MB. Without deleting, a few gigabytes would pile up
    /// in about a year, and when the disk fills, screenshot ingest itself stops.
    /// </summary>
    private void CleanOldMsi(string keep)
    {
        try
        {
            foreach (var old in Directory.EnumerateFiles(paths.Updates, "oXeioAgent-*.msi"))
            {
                if (!string.Equals(old, keep, StringComparison.OrdinalIgnoreCase))
                    TryDelete(old);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.Warn($"Could not remove the old MSI: {ex.Message}");
        }
    }
}
