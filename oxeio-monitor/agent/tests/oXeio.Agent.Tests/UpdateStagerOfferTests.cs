using System.Security.Cryptography;

using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// M2 / L2: what the stager does with the offer's version before anything is downloaded.
/// </summary>
public sealed class UpdateStagerOfferTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "oxeio-offer-" + Guid.NewGuid().ToString("N"));

    private static readonly byte[] Msi = "not really an msi"u8.ToArray();
    private static readonly string Sha = Convert.ToHexString(SHA256.HashData(Msi)).ToLowerInvariant();

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    private async Task<(UpdateStatus Status, FakeSyncClient Sync)> Offer(string version, string running = "1.0.0")
    {
        var sync = new FakeSyncClient
        {
            UpdateBytes = Msi,
            Offer = new UpdateOffer { Version = version, Sha256 = Sha, Url = "/x", Mandatory = false },
        };
        var stager = new UpdateStager(sync, OutboxPaths.ForRoot(_root), running, NullSyncLog.Instance);

        await stager.CheckOnceAsync(CancellationToken.None);
        return (stager.Status, sync);
    }

    [Theory]
    [InlineData(@"..\..\..\evil")]
    [InlineData("9.9.9/../../evil")]
    [InlineData(@"C:\Windows\Temp\evil")]
    [InlineData("v9.9.9")]
    public async Task A_version_that_is_not_plain_SemVer_is_never_downloaded(string version)
    {
        var (status, sync) = await Offer(version);

        Assert.Equal(UpdateStage.None, status.Stage);
        Assert.Equal(0, sync.DownloadCalls);
    }

    [Theory]
    [InlineData("1.0.0")]        // the same version: a replay
    [InlineData("0.9.9")]        // a downgrade
    [InlineData("1.0.0-beta.1")] // a pre-release of what already runs
    public async Task The_same_or_an_older_version_is_never_downloaded(string version)
    {
        var (status, sync) = await Offer(version);

        Assert.Equal(UpdateStage.None, status.Stage);
        Assert.Equal(0, sync.DownloadCalls);
    }

    [Fact]
    public async Task A_newer_version_is_staged_inside_the_updates_folder()
    {
        var (status, _) = await Offer("1.0.1");

        Assert.Equal(UpdateStage.Verified, status.Stage);
        Assert.Equal(
            Path.Combine(Path.GetFullPath(OutboxPaths.ForRoot(_root).Updates), "oXeioAgent-1.0.1.msi"),
            status.MsiPath);
    }
}
