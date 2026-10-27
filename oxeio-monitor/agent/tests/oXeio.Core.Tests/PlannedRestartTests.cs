using oXeio.Core.Watchdog;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>The planned-restart signal between the agent and the watchdog</b> (<c>agent.restart</c>), and
/// how the watchdog treats it: started at once, and not counted as a crash on the ladder.
/// </summary>
public class PlannedRestartTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 26, 9, 0, 0, TimeSpan.Zero);

    private const long Now = 7_200_000;   // 2 hours since boot, unbiased ms

    private static PlannedRestart Sample => new()
    {
        ProcessId = 4242,
        UnbiasedMs = Now - 20_000,
        Reason = "resource_ceiling",
        WrittenAtUtc = new DateTimeOffset(2026, 10, 26, 3, 14, 3, TimeSpan.Zero),
        HandleCount = 217_431,
        PrivateBytes = 7_516_192_768,
    };

    /// <summary>The agent has just exited: lock free, heartbeat file deleted, marker present.</summary>
    private static AgentObservation JustExited(long? markerAt = Now - 20_000) => new()
    {
        ProbeSucceeded = true,
        InstanceLockHeld = false,
        ProcessId = null,
        ProcessAlive = false,
        HeartbeatUnbiasedMs = null,
        NowUnbiasedMs = Now,
        SessionUsable = true,
        ShuttingDown = false,
        PlannedRestartUnbiasedMs = markerAt,
    };

    // ── the file format ─────────────────────────────────────────────────────

    [Fact]
    public void Writing_then_reading_returns_the_same_values()
    {
        var read = PlannedRestartFiles.TryParse(PlannedRestartFiles.Format(Sample));

        Assert.NotNull(read);
        Assert.Equal(Sample, read);
    }

    [Fact]
    public void It_is_one_line()
    {
        Assert.DoesNotContain('\n', PlannedRestartFiles.Format(Sample));
    }

    /// <summary>A space in the reason would split the key=value line; it becomes one token.</summary>
    [Fact]
    public void A_reason_with_spaces_stays_one_token()
    {
        var read = PlannedRestartFiles.TryParse(
            PlannedRestartFiles.Format(Sample with { Reason = "too many handles" }));

        Assert.Equal("too_many_handles", read?.Reason);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("v=1 unbiased=5")]            // no pid: half-written
    [InlineData("v=1 pid=4242")]              // no stamp
    [InlineData("v=1 pid=0 unbiased=5")]
    [InlineData("v=1 pid=4242 unbiased=-1")]
    public void A_broken_line_is_null(string? line)
    {
        Assert.Null(PlannedRestartFiles.TryParse(line));
    }

    /// <summary>An older watchdog must not choke on a newer agent's extra keys, and vice versa.</summary>
    [Fact]
    public void Unknown_keys_are_ignored_and_optional_ones_may_be_missing()
    {
        var read = PlannedRestartFiles.TryParse("v=9 pid=7 unbiased=100 colour=blue");

        Assert.NotNull(read);
        Assert.Equal(7, read.ProcessId);
        Assert.Null(read.HandleCount);
        Assert.Equal("unknown", read.Reason);
    }

    [Fact]
    public void A_marker_is_fresh_within_five_minutes_only()
    {
        var limit = (long)PlannedRestartFiles.MaxAge.TotalMilliseconds;

        Assert.True(PlannedRestartFiles.IsFresh(Now - limit, Now));
        Assert.False(PlannedRestartFiles.IsFresh(Now - limit - 1, Now));
    }

    /// <summary>A stamp from the future is from an earlier boot (the counter restarted): not fresh.</summary>
    [Fact]
    public void A_marker_from_an_earlier_boot_is_not_fresh()
    {
        Assert.False(PlannedRestartFiles.IsFresh(Now + 1, Now));
    }

    [Fact]
    public void The_ceiling_stamp_round_trips_and_garbage_is_null()
    {
        var at = new DateTimeOffset(2026, 10, 26, 3, 14, 3, 120, TimeSpan.Zero);

        Assert.Equal(at, PlannedRestartFiles.TryParseStamp(PlannedRestartFiles.FormatStamp(at)));
        Assert.Null(PlannedRestartFiles.TryParseStamp("yesterday-ish"));
        Assert.Null(PlannedRestartFiles.TryParseStamp(null));
    }

    // ── what the watchdog does with it ──────────────────────────────────────

    [Fact]
    public void A_fresh_marker_with_the_lock_free_is_a_planned_start()
    {
        var d = WatchdogPolicy.Decide(JustExited(), new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Start, d.Action);
        Assert.Equal(WatchdogReason.PlannedRestart, d.Reason);
        Assert.True(d.Planned);
    }

    [Fact]
    public void Without_a_marker_it_is_an_ordinary_start()
    {
        var d = WatchdogPolicy.Decide(JustExited(markerAt: null), new RestartLadder(), T0);

        Assert.Equal(WatchdogReason.AgentMissing, d.Reason);
        Assert.False(d.Planned);
    }

    [Fact]
    public void A_stale_marker_is_an_ordinary_start()
    {
        var stale = Now - (long)PlannedRestartFiles.MaxAge.TotalMilliseconds - 1;

        var d = WatchdogPolicy.Decide(JustExited(stale), new RestartLadder(), T0);

        Assert.Equal(WatchdogReason.AgentMissing, d.Reason);
        Assert.False(d.Planned);
    }

    /// <summary>
    /// While the agent is still inside its graceful exit it holds the lock and its heartbeat is
    /// fresh: it is healthy and must be left alone, marker or not.
    /// </summary>
    [Fact]
    public void While_the_agent_still_holds_the_lock_nothing_happens()
    {
        var obs = JustExited() with
        {
            InstanceLockHeld = true,
            ProcessId = 4242,
            ProcessAlive = true,
            HeartbeatUnbiasedMs = Now - 3_000,
        };

        var d = WatchdogPolicy.Decide(obs, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.None, d.Action);
    }

    /// <summary>Windows shutting down beats the request: starting now could block the shutdown.</summary>
    [Fact]
    public void A_windows_shutdown_still_holds()
    {
        var d = WatchdogPolicy.Decide(JustExited() with { ShuttingDown = true }, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
        Assert.Equal(WatchdogReason.ShuttingDown, d.Reason);
    }

    [Fact]
    public void Session_zero_still_holds()
    {
        var d = WatchdogPolicy.Decide(JustExited() with { SessionUsable = false }, new RestartLadder(), T0);

        Assert.Equal(WatchdogAction.Hold, d.Action);
    }

    /// <summary>A planned restart is not delayed by a backoff left over from earlier failures.</summary>
    [Fact]
    public void A_planned_start_is_not_held_by_the_backoff()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);   // one failure: the next ordinary start would wait 30 s

        var d = WatchdogPolicy.Decide(JustExited(), ladder, T0.AddSeconds(5));

        Assert.Equal(WatchdogAction.Start, d.Action);
        Assert.True(d.Planned);
    }

    // ── the ladder ──────────────────────────────────────────────────────────

    /// <summary>
    /// The core of the design: a planned restart costs no step on the ladder, so the watchdog can
    /// never "give up" on an agent that never failed.
    /// </summary>
    [Fact]
    public void A_planned_launch_does_not_climb_the_ladder()
    {
        var ladder = new RestartLadder();

        for (var i = 0; i < 10; i++) ladder.RecordPlannedLaunch(T0.AddMinutes(i));

        Assert.Equal(0, ladder.Failures);
        Assert.False(ladder.IsExhausted);
        Assert.True(ladder.MayLaunch(T0.AddMinutes(10)));
    }

    /// <summary>
    /// But the storm guard still works after it: a fresh process that crashes right away is counted
    /// the ordinary way from its first crash on.
    /// </summary>
    [Fact]
    public void A_crash_after_a_planned_launch_is_counted_as_usual()
    {
        var ladder = new RestartLadder();
        ladder.RecordPlannedLaunch(T0);

        // the new agent died at once: an ordinary start, which counts
        var d = WatchdogPolicy.Decide(JustExited(markerAt: null), ladder, T0.AddSeconds(30));
        Assert.Equal(WatchdogReason.AgentMissing, d.Reason);
        ladder.RecordLaunch(T0.AddSeconds(30));

        Assert.Equal(1, ladder.Failures);
        Assert.False(ladder.MayLaunch(T0.AddSeconds(31)));
    }

    /// <summary>The new process must earn the stability window again, like any other launch.</summary>
    [Fact]
    public void A_planned_launch_restarts_the_health_streak()
    {
        var ladder = new RestartLadder();
        ladder.RecordLaunch(T0);
        ladder.Observe(healthy: true, T0.AddMinutes(1));

        ladder.RecordPlannedLaunch(T0.AddMinutes(5));
        ladder.Observe(healthy: true, T0.AddMinutes(6));
        ladder.Observe(healthy: true, T0.AddMinutes(12));   // 10 min from the first beat, 6 from the launch

        Assert.Equal(1, ladder.Failures);

        ladder.Observe(healthy: true, T0.AddMinutes(16));   // 10 min of health since the planned launch
        Assert.Equal(0, ladder.Failures);
    }
}
