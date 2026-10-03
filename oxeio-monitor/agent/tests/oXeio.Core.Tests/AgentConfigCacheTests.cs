using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// The last good config, kept across reboots. What has to hold:
///  · a boot without network and with a cache uses the cache;
///  · without a cache, the default — exactly as before;
///  · an invalid config never replaces a valid one.
/// </summary>
public sealed class AgentConfigCacheTests : IDisposable
{
    private readonly string _dir =
        Path.Combine(Path.GetTempPath(), "oxeio-cfg-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    private static readonly DateTimeOffset At = new(2026, 10, 3, 9, 0, 0, TimeSpan.Zero);

    private static AgentConfig Office => AgentConfig.Default with
    {
        IdleThresholdSec = 300,
        ScreenshotFrom = "08:00",
        ScreenshotTo = "20:00",
    };

    private static CachedAgentConfig Cached(AgentConfig cfg, string version = "v1") =>
        new() { Version = version, ReceivedAt = At, Config = cfg };

    // ── AgentConfigCheck ─────────────────────────────────────────────────────

    [Fact]
    public void The_default_config_is_usable()
    {
        Assert.Empty(AgentConfigCheck.Problems(AgentConfig.Default));
    }

    [Fact]
    public void The_server_limits_themselves_are_accepted()
    {
        var edge = AgentConfig.Default with
        {
            IdleThresholdSec = 3600,
            SlotMinutes = 60,
            MonthlyTargetHours = 744,
            ScreenshotFrom = null,
            ScreenshotTo = null,
        };

        Assert.Empty(AgentConfigCheck.Problems(edge));
    }

    [Theory]
    [InlineData(0, 5, 208, "07:00")]
    [InlineData(60, 0, 208, "07:00")]
    [InlineData(60, 5, 0, "07:00")]
    [InlineData(60, 5, 208, "7am")]
    public void A_damaged_config_is_refused(int idle, int slot, double target, string from)
    {
        var bad = AgentConfig.Default with
        {
            IdleThresholdSec = idle,
            SlotMinutes = slot,
            MonthlyTargetHours = target,
            ScreenshotFrom = from,
        };

        Assert.NotEmpty(AgentConfigCheck.Problems(bad));
    }

    // ── codec ────────────────────────────────────────────────────────────────

    [Fact]
    public void Round_trips_with_version_and_time()
    {
        var text = AgentConfigCacheCodec.Serialize(Cached(Office, "abc123"));
        var back = AgentConfigCacheCodec.TryDeserialize(text);

        Assert.NotNull(back);
        Assert.Equal("abc123", back!.Version);
        Assert.Equal(At, back.ReceivedAt);
        // records compare by value, nested ones included
        Assert.Equal(Office, back.Config);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("{\"version\":\"v1\"}")]
    [InlineData("[]")]
    public void Unreadable_text_is_no_cache(string? text)
    {
        Assert.Null(AgentConfigCacheCodec.TryDeserialize(text));
    }

    // ── on disk ──────────────────────────────────────────────────────────────

    [Fact]
    public void Boot_with_a_cache_gets_the_last_config()
    {
        Assert.True(new AgentConfigFile(_dir).TrySave(Cached(Office, "v7")));

        // a fresh instance = the next boot
        var loaded = new AgentConfigFile(_dir).TryLoad();

        Assert.NotNull(loaded);
        Assert.Equal("v7", loaded!.Version);
        Assert.Equal(300, loaded.Config.IdleThresholdSec);
        Assert.Equal("08:00", loaded.Config.ScreenshotFrom);
    }

    [Fact]
    public void Boot_without_a_cache_has_nothing_so_the_default_stays()
    {
        Assert.Null(new AgentConfigFile(_dir).TryLoad());
    }

    [Fact]
    public void An_invalid_config_does_not_replace_the_valid_one()
    {
        var file = new AgentConfigFile(_dir);
        Assert.True(file.TrySave(Cached(Office, "good")));

        var broken = Office with { IdleThresholdSec = 0 };
        Assert.False(file.TrySave(Cached(broken, "bad")));

        Assert.Equal("good", file.TryLoad()!.Version);
    }

    [Fact]
    public void A_corrupt_file_is_ignored()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, AgentConfigFile.FileName), "{ half a file");

        Assert.Null(new AgentConfigFile(_dir).TryLoad());
    }

    [Fact]
    public void A_newer_config_replaces_the_older_one_and_leaves_no_temp_file()
    {
        var file = new AgentConfigFile(_dir);
        file.TrySave(Cached(Office, "v1"));
        file.TrySave(Cached(Office with { SlotMinutes = 10 }, "v2"));

        var loaded = file.TryLoad()!;
        Assert.Equal("v2", loaded.Version);
        Assert.Equal(10, loaded.Config.SlotMinutes);
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
    }
}
