using System.Security.Cryptography;

using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// H1: the staged MSI is checked again, through a lock, right before msiexec. A file swapped
/// after verification must never be handed to msiexec, and a locked one must not be swappable.
/// </summary>
public sealed class UpdateLockTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "oxeio-lock-" + Guid.NewGuid().ToString("N"));

    private static readonly byte[] Msi = "not really an msi"u8.ToArray();
    private static readonly string Sha = Convert.ToHexString(SHA256.HashData(Msi)).ToLowerInvariant();

    private readonly ECDsa _owner = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public void Dispose()
    {
        _owner.Dispose();
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    private string OwnerPublicKey => Convert.ToBase64String(_owner.ExportSubjectPublicKeyInfo());

    private string Sign(byte[] bytes) => Convert.ToBase64String(
        _owner.SignHash(SHA256.HashData(bytes), DSASignatureFormat.Rfc3279DerSequence));

    private async Task<UpdateStager> Staged(string? pcKey = null, string? signature = null)
    {
        var sync = new FakeSyncClient
        {
            UpdateBytes = Msi,
            Offer = new UpdateOffer
            {
                Version = "9.9.9", Sha256 = Sha, Url = "/x", Mandatory = false, Signature = signature,
            },
        };
        var stager = new UpdateStager(sync, OutboxPaths.ForRoot(_root), "1.0.0", NullSyncLog.Instance, pcKey);
        await stager.CheckOnceAsync(CancellationToken.None);
        Assert.Equal(UpdateStage.Verified, stager.Status.Stage);
        return stager;
    }

    // ── the pure check ──────────────────────────────────────────────────

    private static UpdateStatus Verified(string? sha, string? signature = null) =>
        new() { Stage = UpdateStage.Verified, Version = "9.9.9", Sha256 = sha, Signature = signature };

    [Fact]
    public void The_same_bytes_pass() =>
        Assert.Null(UpdateStager.RecheckProblem(Sha, Verified(Sha.ToUpperInvariant()), null, false));

    [Fact]
    public void Other_bytes_are_refused() =>
        Assert.Contains("changed", UpdateStager.RecheckProblem(new string('0', 64), Verified(Sha), null, false));

    [Fact]
    public void Without_a_recorded_hash_nothing_is_trusted() =>
        Assert.NotNull(UpdateStager.RecheckProblem(Sha, Verified(null), null, false));

    [Fact]
    public void The_owner_signature_is_checked_again()
    {
        var key = UpdateSignature.ParsePublicKey(OwnerPublicKey);

        Assert.Null(UpdateStager.RecheckProblem(Sha, Verified(Sha, Sign(Msi)), key, false));
        Assert.NotNull(UpdateStager.RecheckProblem(Sha, Verified(Sha, null), key, false));
        Assert.NotNull(UpdateStager.RecheckProblem(Sha, Verified(Sha, Sign("other"u8.ToArray())), key, false));
        Assert.NotNull(UpdateStager.RecheckProblem(Sha, Verified(Sha, Sign(Msi)), null, keyUnreadable: true));
    }

    [Theory]
    [InlineData(@"\\?\C:\ProgramData\oXeio\updates\a.msi", @"C:\ProgramData\oXeio\updates\a.msi")]
    [InlineData(@"\\?\UNC\server\share\a.msi", @"\\server\share\a.msi")]
    [InlineData(@"C:\x\a.msi", @"C:\x\a.msi")]
    public void The_device_prefix_is_removed(string final, string expected) =>
        Assert.Equal(expected, UpdateLock.StripDevicePrefix(final));

    // ── on the real file system ─────────────────────────────────────────

    [Fact]
    public async Task The_verified_file_is_locked_and_given_by_its_real_path()
    {
        var stager = await Staged();

        using var held = stager.LockForInstall();

        Assert.NotNull(held);
        Assert.Equal(stager.Status.MsiPath, held.FinalPath, ignoreCase: true);
    }

    [Fact]
    public async Task A_file_swapped_after_verification_is_refused_and_deleted()
    {
        var stager = await Staged();
        var msi = stager.Status.MsiPath!;

        File.WriteAllBytes(msi, "an attacker's msi"u8.ToArray());

        Assert.Null(stager.LockForInstall());
        Assert.Equal(UpdateStage.Corrupt, stager.Status.Stage);
        Assert.False(File.Exists(msi));
    }

    [Fact]
    public async Task A_swapped_file_is_refused_even_when_the_signature_used_to_be_valid()
    {
        var stager = await Staged(OwnerPublicKey, Sign(Msi));

        File.WriteAllBytes(stager.Status.MsiPath!, "an attacker's msi"u8.ToArray());

        Assert.Null(stager.LockForInstall());
    }

    [Fact]
    public async Task While_locked_the_file_cannot_be_written_renamed_or_deleted()
    {
        var stager = await Staged();
        var msi = stager.Status.MsiPath!;

        using var held = stager.LockForInstall();
        Assert.NotNull(held);

        Assert.ThrowsAny<IOException>(() => File.WriteAllBytes(msi, [1, 2, 3]));
        Assert.ThrowsAny<IOException>(() => File.Move(msi, msi + ".old"));
        Assert.ThrowsAny<Exception>(() => File.Delete(msi));

        // ...but it can still be read, which is all msiexec does
        using (var reader = new FileStream(msi, FileMode.Open, FileAccess.Read, FileShare.Read))
            Assert.Equal(Msi.Length, reader.Length);
    }

    [Fact]
    public async Task While_locked_the_updates_folder_cannot_be_moved_away()
    {
        var stager = await Staged();
        var updates = OutboxPaths.ForRoot(_root).Updates;

        using var held = stager.LockForInstall();
        Assert.NotNull(held);

        Assert.ThrowsAny<IOException>(() => Directory.Move(updates, updates + "-moved"));
    }

    [Fact]
    public async Task A_file_someone_holds_open_for_writing_cannot_be_locked()
    {
        var stager = await Staged();

        using (new FileStream(stager.Status.MsiPath!, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
        {
            Assert.Null(stager.LockForInstall());
        }
    }

    [Fact]
    public async Task After_release_the_file_is_free_again()
    {
        var stager = await Staged();
        var msi = stager.Status.MsiPath!;

        stager.LockForInstall()!.Dispose();

        File.Delete(msi);
        Assert.False(File.Exists(msi));
    }
}
