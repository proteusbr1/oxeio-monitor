using oXeio.Core.Agent;
using oXeio.Core.Models;
using oXeio.Core.Time;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// The work-day offset is process-wide state (<see cref="WorkTime.TrySet"/>),
/// so every test that changes it lives in this collection: xUnit runs a
/// collection with parallelisation disabled on its own, after the others.
/// Without that, the Dhaka tests in other classes could see São Paulo's offset
/// halfway through.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class WorkTimeZoneCollection
{
    public const string Name = "work time zone (process-wide offset)";
}

/// <summary>
/// The server may run on another zone without DST (<c>WORK_TIMEZONE</c>) and
/// sends <c>utcOffsetMinutes</c> in the config. These tests check that:
///  1. by default nothing changes — Asia/Dhaka, UTC+06:00;
///  2. with America/Sao_Paulo (−180) days, the capture window and midnight
///     splits follow São Paulo's clock, across month and year boundaries.
/// </summary>
[Collection(WorkTimeZoneCollection.Name)]
public sealed class WorkTimeZoneTests : IDisposable
{
    private const string SaoPaulo = "America/Sao_Paulo";

    public WorkTimeZoneTests() => WorkTime.Reset();

    public void Dispose() => WorkTime.Reset();

    private static DateTimeOffset Utc(int y, int mo, int d, int h, int mi = 0) =>
        new(y, mo, d, h, mi, 0, TimeSpan.Zero);

    [Fact]
    public void Default_zone_is_UTC_plus_six()
    {
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
        Assert.Equal("Asia/Dhaka", WorkTime.TimeZoneName);
        Assert.Equal("Dhaka", WorkTime.Label);
        Assert.Equal(360, AgentConfig.Default.UtcOffsetMinutes);
        Assert.Equal(new DateOnly(2026, 8, 9), WorkTime.WorkDateOf(Utc(2026, 8, 8, 18)));
    }

    [Fact]
    public void Sao_Paulo_day_turns_at_local_midnight()
    {
        Assert.True(WorkTime.TrySet(SaoPaulo, -180));
        Assert.Equal("Sao Paulo", WorkTime.Label);

        Assert.Equal(new DateOnly(2026, 8, 10), WorkTime.WorkDateOf(Utc(2026, 8, 11, 2, 59)));
        Assert.Equal(new DateOnly(2026, 8, 11), WorkTime.WorkDateOf(Utc(2026, 8, 11, 3)));
        // 15:00 local — where the Dhaka offset used to turn the day
        Assert.Equal(new DateOnly(2026, 8, 11), WorkTime.WorkDateOf(Utc(2026, 8, 11, 18)));
        Assert.Equal(new TimeOnly(7, 5), WorkTime.LocalTimeOf(Utc(2026, 8, 11, 10, 5)));
        Assert.Equal(Utc(2026, 8, 12, 3), WorkTime.NextLocalMidnight(Utc(2026, 8, 11, 15)));
    }

    [Fact]
    public void Sao_Paulo_month_and_year_roll_over_at_local_midnight()
    {
        WorkTime.TrySet(SaoPaulo, -180);

        Assert.Equal(new DateOnly(2026, 8, 31), WorkTime.WorkDateOf(Utc(2026, 9, 1, 2, 30)));
        Assert.Equal(new DateOnly(2026, 12, 31), WorkTime.WorkDateOf(Utc(2027, 1, 1, 2, 59)));
        Assert.Equal(new DateOnly(2027, 1, 1), WorkTime.WorkDateOf(Utc(2027, 1, 1, 3)));
        Assert.Equal(Utc(2027, 1, 1, 3), WorkTime.NextLocalMidnight(Utc(2026, 12, 31, 23)));
    }

    [Fact]
    public void Capture_window_07_23_is_local_time()
    {
        WorkTime.TrySet(SaoPaulo, -180);
        var window = CaptureWindow.Default;

        Assert.False(window.Allows(Utc(2026, 8, 11, 9, 59)));  // 06:59 local
        Assert.True(window.Allows(Utc(2026, 8, 11, 10)));      // 07:00 local
        Assert.True(window.Allows(Utc(2026, 8, 12, 1, 59)));   // 22:59 local
        Assert.False(window.Allows(Utc(2026, 8, 12, 2)));      // 23:00 local
    }

    [Fact]
    public void Segments_split_at_Sao_Paulo_midnight()
    {
        WorkTime.TrySet(SaoPaulo, -180);
        var lateNight = Utc(2026, 8, 12, 2, 50); // 23:50 local, 11 Aug
        var sm = new IdleStateMachine(TimeSpan.FromSeconds(60), lateNight);

        var closed = new List<ActivitySegment>();
        for (var i = 1; i <= 20 * 60; i++)
            closed.AddRange(sm.Tick(lateNight.AddSeconds(i), TimeSpan.Zero, false, screenFrozen: false));
        closed.AddRange(sm.CloseAll(lateNight.AddMinutes(20)));

        var midnight = Utc(2026, 8, 12, 3);
        var before = closed.Where(c => c.EndedAt <= midnight).ToList();
        var after = closed.Where(c => c.StartedAt >= midnight).ToList();

        Assert.All(before, c => Assert.Equal(new DateOnly(2026, 8, 11), c.WorkDate));
        Assert.Equal(600, before.Sum(c => c.DurationSec));
        Assert.All(after, c => Assert.Equal(new DateOnly(2026, 8, 12), c.WorkDate));
        Assert.Equal(600, after.Sum(c => c.DurationSec));
    }

    [Theory]
    [InlineData(-721)]
    [InlineData(841)]
    public void An_impossible_offset_is_refused_and_nothing_changes(int minutes)
    {
        Assert.False(WorkTime.TrySet(SaoPaulo, minutes));
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
        Assert.Equal("Asia/Dhaka", WorkTime.TimeZoneName);
    }

    [Fact]
    public void The_remembered_line_round_trips()
    {
        WorkTime.TrySet(SaoPaulo, -180);
        var line = WorkTime.ToMemoryLine();
        Assert.Equal("America/Sao_Paulo|-180", line);

        WorkTime.Reset();
        Assert.True(WorkTime.TryRestore(line));
        Assert.Equal(TimeSpan.FromHours(-3), WorkTime.Offset);
        Assert.Equal(SaoPaulo, WorkTime.TimeZoneName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("America/Sao_Paulo")]
    [InlineData("America/Sao_Paulo|")]
    [InlineData("America/Sao_Paulo|abc")]
    [InlineData("|-180")]
    [InlineData("Somewhere|9999")]
    public void A_broken_remembered_line_keeps_the_current_zone(string? line)
    {
        Assert.False(WorkTime.TryRestore(line));
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
    }

    [Fact]
    public void An_empty_zone_name_is_refused()
    {
        Assert.False(WorkTime.TrySet(" ", -180));
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.Offset);
    }
}

/// <summary>
/// Daylight saving: the server sends its zone's offset changes and the agent cuts
/// days with them. Europe/Lisbon 2026: UTC+0 until 29 Mar 01:00 UTC, UTC+1 until
/// 25 Oct 01:00 UTC — the same table the server's own tests check.
/// </summary>
[Collection(WorkTimeZoneCollection.Name)]
public sealed class WorkTimeDaylightSavingTests : IDisposable
{
    private static readonly ZoneTransition[] Lisbon2026 =
    [
        new() { At = Utc(2026, 1, 1, 0), OffsetMinutes = 0 },
        new() { At = Utc(2026, 3, 29, 1), OffsetMinutes = 60 },
        new() { At = Utc(2026, 10, 25, 1), OffsetMinutes = 0 },
    ];

    public WorkTimeDaylightSavingTests()
    {
        WorkTime.Reset();
        Assert.True(WorkTime.TrySet("Europe/Lisbon", 60, Lisbon2026));
    }

    public void Dispose() => WorkTime.Reset();

    private static DateTimeOffset Utc(int y, int mo, int d, int h, int mi = 0) =>
        new(y, mo, d, h, mi, 0, TimeSpan.Zero);

    [Fact]
    public void Each_instant_uses_the_offset_in_force_then()
    {
        Assert.Equal(TimeSpan.Zero, WorkTime.OffsetAt(Utc(2026, 1, 15, 12)));
        Assert.Equal(TimeSpan.FromHours(1), WorkTime.OffsetAt(Utc(2026, 7, 15, 12)));
        Assert.Equal(TimeSpan.FromHours(1), WorkTime.OffsetAt(Utc(2026, 3, 29, 1)));
        Assert.Equal(TimeSpan.Zero, WorkTime.OffsetAt(Utc(2026, 3, 29, 0, 59)));

        // 23:30 UTC: the same day in winter, already the next in summer
        Assert.Equal(new DateOnly(2026, 1, 1), WorkTime.WorkDateOf(Utc(2026, 1, 1, 23, 30)));
        Assert.Equal(new DateOnly(2026, 7, 2), WorkTime.WorkDateOf(Utc(2026, 7, 1, 23, 30)));
        Assert.Equal(new TimeOnly(11, 0), WorkTime.LocalTimeOf(Utc(2026, 7, 1, 10)));
    }

    [Fact]
    public void Days_of_23_and_25_hours_end_at_the_right_moment()
    {
        // 29 Mar starts at 00:00 UTC (winter) and ends at 23:00 UTC (summer)
        Assert.Equal(Utc(2026, 3, 29, 23), WorkTime.NextLocalMidnight(Utc(2026, 3, 29, 12)));
        // 25 Oct starts at 23:00 UTC the day before and ends at 00:00 UTC on the 26th
        Assert.Equal(Utc(2026, 10, 26, 0), WorkTime.NextLocalMidnight(Utc(2026, 10, 25, 12)));
        Assert.Equal(Utc(2026, 7, 2, 23), WorkTime.NextLocalMidnight(Utc(2026, 7, 2, 12)));
    }

    [Fact]
    public void The_table_survives_a_restart()
    {
        var line = WorkTime.ToMemoryLine();
        Assert.StartsWith("Europe/Lisbon|60|", line);

        WorkTime.Reset();
        Assert.True(WorkTime.TryRestore(line));
        Assert.Equal(3, WorkTime.TransitionCount);
        Assert.Equal(TimeSpan.FromHours(1), WorkTime.OffsetAt(Utc(2026, 7, 15, 12)));
        Assert.Equal(line, WorkTime.ToMemoryLine());
    }

    [Fact]
    public void A_table_out_of_order_or_out_of_range_is_refused()
    {
        ZoneTransition[] backwards = [Lisbon2026[1], Lisbon2026[0]];
        Assert.False(WorkTime.TrySet("Europe/Lisbon", 0, backwards));
        ZoneTransition[] wild = [new() { At = Utc(2026, 1, 1, 0), OffsetMinutes = 9999 }];
        Assert.False(WorkTime.TrySet("Europe/Lisbon", 0, wild));
        // the earlier table is still in force
        Assert.Equal(3, WorkTime.TransitionCount);
    }

    [Fact]
    public void An_older_server_without_a_table_keeps_one_offset()
    {
        Assert.True(WorkTime.TrySet("Asia/Dhaka", 360));
        Assert.Equal(0, WorkTime.TransitionCount);
        Assert.Equal(TimeSpan.FromHours(6), WorkTime.OffsetAt(Utc(2026, 7, 15, 12)));
        Assert.Equal("Asia/Dhaka|360", WorkTime.ToMemoryLine());
    }
}
