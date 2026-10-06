using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Core.Agent;
using oXeio.Core.Time;

namespace oXeio.Agent.Tests;

/// <summary>
/// The work-day zone, from the wire to the disk. These tests change the
/// process-wide offset in <see cref="WorkTime"/>, so they run on their own
/// (see the collection), never next to tests that count days in the test zone.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class WorkZoneCollection
{
    public const string Name = "work zone (process-wide offset)";
}

[Collection(WorkZoneCollection.Name)]
public sealed class WorkZoneTests : IDisposable
{
    private readonly string _dir =
        Path.Combine(Path.GetTempPath(), "oxeio-zone-" + Guid.NewGuid().ToString("N"));

    public WorkZoneTests() => WorkTime.Reset();

    public void Dispose()
    {
        WorkTime.Reset();
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    private const string ConfigJson = """
        {
          "version": "abc",
          "config": {
            "idleThresholdSec": 60,
            "slotMinutes": 5,
            "screenshotFrom": "07:00",
            "screenshotTo": "23:00",
            "timezone": "America/Sao_Paulo",
            "utcOffsetMinutes": -180,
            "monthlyTargetHours": 208,
            "heartbeatSec": 30,
            "appTracking": { "enabled": true, "minDurationSec": 5 },
            "screenshot": { "format": "webp", "quality": 70, "maxWidth": 1920, "allMonitors": true }
          }
        }
        """;

    [Fact]
    public void The_config_carries_the_offset()
    {
        var res = SyncJson.TryDeserialize<ConfigResponse>(ConfigJson);

        Assert.NotNull(res);
        Assert.Equal("America/Sao_Paulo", res!.Config.Timezone);
        Assert.Equal(-180, res.Config.UtcOffsetMinutes);
    }

    [Fact]
    public void The_config_carries_the_daylight_saving_table()
    {
        var json = ConfigJson.Replace(
            "\"utcOffsetMinutes\": -180,",
            "\"utcOffsetMinutes\": 60, \"zoneTransitions\": [" +
            "{ \"at\": \"2026-09-01T00:00:00.000Z\", \"offsetMinutes\": 60 }," +
            "{ \"at\": \"2026-10-25T01:00:00.000Z\", \"offsetMinutes\": 0 }],");
        var res = SyncJson.TryDeserialize<ConfigResponse>(json);

        Assert.NotNull(res);
        var table = res!.Config.ZoneTransitions;
        Assert.NotNull(table);
        Assert.Equal(2, table!.Count);
        Assert.Equal(new DateTimeOffset(2026, 10, 25, 1, 0, 0, TimeSpan.Zero), table[1].At);
        Assert.Equal(0, table[1].OffsetMinutes);
        Assert.True(WorkTime.TrySet(res.Config.Timezone, 60, table));
        Assert.Equal(new DateOnly(2026, 10, 25), WorkTime.WorkDateOf(new DateTimeOffset(2026, 10, 24, 23, 30, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void An_older_server_without_the_field_gives_null_not_zero()
    {
        // null keeps the current zone; 0 would move every day to UTC
        var json = ConfigJson.Replace("\"utcOffsetMinutes\": -180,", "");
        var res = SyncJson.TryDeserialize<ConfigResponse>(json);

        Assert.NotNull(res);
        Assert.Null(res!.Config.UtcOffsetMinutes);
    }

    [Fact]
    public void The_last_zone_survives_a_restart()
    {
        WorkTime.TrySet("America/Sao_Paulo", -180);
        new WorkZoneMemory(_dir).Remember();

        WorkTime.Reset();
        Assert.True(new WorkZoneMemory(_dir).TryRestore());
        Assert.Equal(TimeSpan.FromHours(-3), WorkTime.Offset);
    }

    [Fact]
    public void First_boot_has_nothing_to_restore_and_stays_on_the_default_zone()
    {
        Assert.False(new WorkZoneMemory(_dir).TryRestore());
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
    }

    [Fact]
    public void A_corrupt_file_is_ignored()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "work-zone.txt"), "garbage");

        Assert.False(new WorkZoneMemory(_dir).TryRestore());
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
    }
}
