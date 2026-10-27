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

        // H1: what was verified is remembered, so the install can check the file again
        _status = _status with
        {
            Stage = UpdateStage.Verified,
            Sha256 = file.Sha256,
            Signature = offer.Signature,
        };
        log.Info(
            $"✅ Update {offer.Version} verified" +
            (signature == SignatureCheck.Valid ? " (hash and owner's signature)" : "") +
            $" — waiting to be installed: {file.SavedPath}");

        // Downloaded MSIs of older versions are no longer needed
        CleanOldMsi(file.SavedPath);
    }

    /// <summary>
    /// <b>H1: the file msiexec is about to run, locked and verified again.</b> <c>null</c> (with
    /// the reason logged, the file deleted and the status set to <see cref="UpdateStage.Corrupt"/>,
    /// so the next check downloads it again) when it cannot be trusted.
    ///
    /// <b>The attack this closes:</b> the MSI waits in <c>%ProgramData%\oXeio\updates</c> for
    /// hours or days, and every standard user may modify files there (Users = Modify, inherited;
    /// <see cref="Security.AgentDataDirectory"/>). The monitored staff member could replace it with
    /// their own MSI; an administrator then approves the UAC prompt for "the oXeio update", and the
    /// replaced MSI runs as SYSTEM. The check at download time does not help: it describes the
    /// file as it was then.
    ///
    /// Careful: <b>checking again by path is not enough either</b>: "hash the file, then start
    /// msiexec on the path" leaves a gap between the two in which the file can be swapped again
    /// (a classic time-of-check / time-of-use race, and easy to win: the UAC prompt alone keeps
    /// the gap open for as long as the admin takes to read it). So the file is opened
    /// <b>first</b>, with a handle that allows others to read but not to write, rename or delete
    /// (<see cref="UpdateLock"/>); the hash is computed <b>through that handle</b>; and the handle
    /// stays open until msiexec is done with the file. While it is open, the bytes that were hashed
    /// are the bytes msiexec reads.
    ///
    /// The signature is checked again too, against what was recorded at verification time
    /// (<see cref="UpdateStatus.Sha256"/>, <see cref="UpdateStatus.Signature"/>), not against the
    /// server's current word.
    ///
    /// Careful: this hashes the whole MSI (~62 MB) on the caller's thread; a fraction of a second,
    /// and only when the staff member clicks "Install update".
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    internal UpdateLock? LockForInstall()
    {
        var status = _status;
        if (status.Stage != UpdateStage.Verified || string.IsNullOrWhiteSpace(status.MsiPath)) return null;

        var msi = status.MsiPath;

        if (!UpdateLock.TryAcquire(paths.Updates, msi, out var held, out var why))
        {
            RefuseAtInstall(status, msi, why);
            return null;
        }

        string actual;
        try
        {
            actual = held.ComputeSha256();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            held.Dispose();
            RefuseAtInstall(status, msi, $"could not read it: {ex.Message}");
            return null;
        }

        var problem = RecheckProblem(actual, status, _updateKey, KeyUnreadable);
        if (problem is not null)
        {
            held.Dispose();
            RefuseAtInstall(status, msi, problem);
            return null;
        }

        log.Info($"Update {status.Version} checked again and locked for msiexec: {held.FinalPath}");
        return held;
    }

    /// <summary>
    /// The pure part of the install-time check: <c>null</c> if the file hashed now is the one
    /// that was verified and (when this PC has the owner's key) still carries a valid owner
    /// signature; otherwise why not.
    /// </summary>
    internal static string? RecheckProblem(string actualSha256, UpdateStatus verified, ECDsa? key, bool keyUnreadable)
    {
        if (string.IsNullOrWhiteSpace(verified.Sha256))
            return "no hash was recorded when it was verified";

        if (!string.Equals(actualSha256, verified.Sha256, StringComparison.OrdinalIgnoreCase))
            return $"the file changed since it was verified (expected {verified.Sha256}, now {actualSha256})";

        if (keyUnreadable) return "the UpdatePublicKey on this PC cannot be read";

        return UpdateSignature.Verify(key, actualSha256, verified.Signature) switch
        {
            SignatureCheck.Missing => "the owner's signature is missing",
            SignatureCheck.Invalid => "the owner's signature does not match",
            _ => null,
        };
    }

    private void RefuseAtInstall(UpdateStatus status, string msi, string why)
    {
        log.Error(
            $"⛔ Update {status.Version} NOT started — {why}. msiexec was not run; " +
            "the file is being deleted and will be downloaded again.");

        TryDelete(msi);

        // Careful: compared before overwriting. A check that finished meanwhile may already have
        // staged something newer; that must not be marked corrupt by this old refusal.
        Interlocked.CompareExchange(
            ref _status,
            status with { Stage = UpdateStage.Corrupt, MsiPath = null, Detail = "changed on disk" },
            status);
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
