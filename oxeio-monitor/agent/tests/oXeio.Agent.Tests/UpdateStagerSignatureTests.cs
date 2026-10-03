using System.Security.Cryptography;

using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// The update stager with an owner's key on the PC: only an MSI signed with
/// that key reaches <see cref="UpdateStage.Verified"/>; anything else is
/// deleted. Without a key nothing changes.
/// </summary>
public sealed class UpdateStagerSignatureTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "oxeio-upd-" + Guid.NewGuid().ToString("N"));

    private static readonly byte[] Msi = "not really an msi"u8.ToArray();
    private static readonly string Sha = Convert.ToHexString(SHA256.HashData(Msi)).ToLowerInvariant();

    private readonly ECDsa _owner = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public void Dispose()
    {
        _owner.Dispose();
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    private string OwnerPublicKey => Convert.ToBase64String(_owner.ExportSubjectPublicKeyInfo());

    private string SignedBy(ECDsa key) => Convert.ToBase64String(
        key.SignHash(SHA256.HashData(Msi), DSASignatureFormat.Rfc3279DerSequence));

    private async Task<UpdateStatus> Stage(string? signature, string? pcKey)
    {
        var sync = new FakeSyncClient
        {
            UpdateBytes = Msi,
            Offer = new UpdateOffer
            {
                Version = "9.9.9",
                Sha256 = Sha,
                Url = "/x",
                Mandatory = false,
                Signature = signature,
            },
        };
        var stager = new UpdateStager(
            sync, OutboxPaths.ForRoot(_root), "1.0.0", NullSyncLog.Instance, pcKey);

        await stager.CheckOnceAsync(CancellationToken.None);
        return stager.Status;
    }

    [Fact]
    public async Task No_key_on_the_PC_the_hash_is_enough_as_before()
    {
        var status = await Stage(signature: null, pcKey: null);
        Assert.Equal(UpdateStage.Verified, status.Stage);
    }

    [Fact]
    public async Task Signed_by_the_owner_is_verified()
    {
        var status = await Stage(SignedBy(_owner), OwnerPublicKey);
        Assert.Equal(UpdateStage.Verified, status.Stage);
        Assert.True(File.Exists(status.MsiPath));
    }

    [Fact]
    public async Task Unsigned_is_refused_and_deleted_when_the_PC_has_a_key()
    {
        var status = await Stage(signature: null, OwnerPublicKey);
        Assert.Equal(UpdateStage.Corrupt, status.Stage);
        Assert.Equal("signature missing", status.Detail);
        Assert.Empty(Directory.EnumerateFiles(OutboxPaths.ForRoot(_root).Updates));
    }

    [Fact]
    public async Task Signed_by_someone_else_is_refused()
    {
        using var attacker = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var status = await Stage(SignedBy(attacker), OwnerPublicKey);
        Assert.Equal(UpdateStage.Corrupt, status.Stage);
        Assert.Equal("signature invalid", status.Detail);
    }

    [Fact]
    public async Task An_unreadable_key_refuses_everything_instead_of_turning_the_check_off()
    {
        var status = await Stage(SignedBy(_owner), pcKey: "garbage");
        Assert.Equal(UpdateStage.Corrupt, status.Stage);
    }
}
