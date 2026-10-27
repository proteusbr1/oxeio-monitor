using oXeio.Core.Watchdog;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>When the agent restarts itself to free what it holds.</b> The field case: <c>nvspcap64.dll</c>
/// (NVIDIA overlay) leaked ~217k handles and 7 GB in one agent over twelve days.
///
/// The asymmetry under test: restarting while someone works costs ~30 s of their counted time; a
/// restart loop, or exiting with nobody to start us again, costs the day. Every doubt goes to "do
/// not restart".
/// </summary>
public class ResourceCeilingTests
{
    private static readonly DateTimeOffset Mono = new(2026, 10, 26, 9, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Utc = new(2026, 10, 26, 3, 0, 0, TimeSpan.Zero);

    private static ResourceSample Healthy => new()
    {
        HandleCount = 900,
        PrivateBytes = 120_000_000,
        GdiObjects = 40,
        UserObjects = 30,
    };

    private static ResourceSample OverHandles => Healthy with { HandleCount = ResourceCeiling.MaxHandles + 1 };

    /// <summary>Over the ceiling, old enough, watchdog present, never restarted, user working.</summary>
    private static CeilingInput Busy(ResourceSample sample) => new()
    {
        Sample = sample,
        Now = Mono,
        Uptime = TimeSpan.FromHours(30),
        Quiet = false,
        ShuttingDown = false,
        WatchdogPresent = true,
        LastRestartUtc = null,
        NowUtc = Utc,
    };

    // ── under the ceiling ───────────────────────────────────────────────────

    [Fact]
    public void A_healthy_agent_does_nothing_and_has_no_over_since()
    {
        var d = ResourceCeiling.Decide(Busy(Healthy) with { OverSince = Mono.AddMinutes(-5) });

        Assert.Equal(CeilingAction.None, d.Action);
        Assert.Equal(CeilingReason.WithinLimits, d.Reason);
        Assert.Null(d.OverSince);
    }

    [Fact]
    public void Exactly_at_the_ceiling_is_not_over()
    {
        Assert.False(ResourceCeiling.IsOver(Healthy with { HandleCount = ResourceCeiling.MaxHandles }));
        Assert.False(ResourceCeiling.IsOver(Healthy with { PrivateBytes = ResourceCeiling.MaxPrivateBytes }));
        Assert.True(ResourceCeiling.IsOver(Healthy with { PrivateBytes = ResourceCeiling.MaxPrivateBytes + 1 }));
    }

    /// <summary>A known DLL being loaded is a report, not a reason to restart.</summary>
    [Fact]
    public void A_loaded_watched_dll_alone_is_not_over()
    {
        Assert.False(ResourceCeiling.IsOver(Healthy with { InjectedModules = ["nvspcap64.dll"] }));
    }

    /// <summary>GDI/USER objects are reported but do not trip the ceiling (Windows caps them itself).</summary>
    [Fact]
    public void Gui_objects_do_not_trip_the_ceiling()
    {
        Assert.False(ResourceCeiling.IsOver(Healthy with { GdiObjects = 9_999, UserObjects = 9_999 }));
    }

    // ── over: waiting for a quiet moment ────────────────────────────────────

    [Fact]
    public void Over_while_the_user_is_working_waits_and_starts_the_clock()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles));

        Assert.Equal(CeilingAction.Wait, d.Action);
        Assert.Equal(CeilingReason.WaitingForQuiet, d.Reason);
        Assert.Equal(Mono, d.OverSince);
    }

    [Fact]
    public void Over_at_a_quiet_moment_restarts()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with { Quiet = true });

        Assert.Equal(CeilingAction.Restart, d.Action);
        Assert.Equal(CeilingReason.QuietMoment, d.Reason);
    }

    [Fact]
    public void The_over_since_anchor_is_kept_across_checks()
    {
        var since = Mono.AddMinutes(-20);

        var d = ResourceCeiling.Decide(Busy(OverHandles) with { OverSince = since });

        Assert.Equal(since, d.OverSince);
    }

    // ── over: the hard caps ─────────────────────────────────────────────────

    /// <summary>Someone typing for an hour straight must not keep a leak alive forever.</summary>
    [Fact]
    public void Over_for_an_hour_restarts_even_while_busy()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with
        {
            OverSince = Mono - ResourceCeiling.MaxWaitForQuiet,
        });

        Assert.Equal(CeilingAction.Restart, d.Action);
        Assert.Equal(CeilingReason.OverTooLong, d.Reason);
    }

    [Fact]
    public void Just_under_an_hour_still_waits()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with
        {
            OverSince = Mono - ResourceCeiling.MaxWaitForQuiet + TimeSpan.FromSeconds(1),
        });

        Assert.Equal(CeilingAction.Wait, d.Action);
    }

    [Theory]
    [InlineData(ResourceCeiling.MaxHandles * ResourceCeiling.HardFactor + 1, 0)]
    [InlineData(0, ResourceCeiling.MaxPrivateBytes * ResourceCeiling.HardFactor + 1)]
    public void Twice_over_restarts_at_once_even_while_busy(long handles, long privateBytes)
    {
        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = handles, PrivateBytes = privateBytes }));

        Assert.Equal(CeilingAction.Restart, d.Action);
        Assert.Equal(CeilingReason.HardCeiling, d.Reason);
    }

    /// <summary>The field case itself: 217k handles, 7 GB.</summary>
    [Fact]
    public void The_field_leak_restarts_at_once()
    {
        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = 217_431, PrivateBytes = 7_516_192_768 }));

        Assert.Equal(CeilingAction.Restart, d.Action);
    }

    // ── the loop guards ─────────────────────────────────────────────────────

    /// <summary>
    /// The no-loop guarantee: a fresh process that is over again within six hours means the restart
    /// did not help. It reports, and does not restart, not even when twice over.
    /// </summary>
    [Fact]
    public void A_restart_less_than_six_hours_ago_only_reports_even_when_twice_over()
    {
        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = 217_431 }) with
        {
            Quiet = true,
            LastRestartUtc = Utc.AddHours(-5),
        });

        Assert.Equal(CeilingAction.ReportOnly, d.Action);
        Assert.Equal(CeilingReason.BackedOff, d.Reason);
    }

    [Fact]
    public void Six_hours_after_the_last_restart_it_may_restart_again()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with
        {
            Quiet = true,
            LastRestartUtc = Utc - ResourceCeiling.MinGapBetweenRestarts,
        });

        Assert.Equal(CeilingAction.Restart, d.Action);
    }

    /// <summary>
    /// The clock was set back: the stamp is "in the future". Trusting it would block restarts for
    /// as long as the clock was moved; one extra restart is the harmless side.
    /// </summary>
    [Fact]
    public void A_stamp_in_the_future_does_not_block()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with
        {
            Quiet = true,
            LastRestartUtc = Utc.AddDays(300),
        });

        Assert.Equal(CeilingAction.Restart, d.Action);
    }

    [Fact]
    public void A_young_process_waits_even_when_twice_over()
    {
        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = 217_431 }) with
        {
            Uptime = ResourceCeiling.MinUptime - TimeSpan.FromSeconds(1),
            Quiet = true,
        });

        Assert.Equal(CeilingAction.Wait, d.Action);
        Assert.Equal(CeilingReason.TooYoung, d.Reason);
    }

    /// <summary>
    /// The watchdog ladder resets after 10 min of health; the agent must not ask for a planned
    /// restart before that, or the planned start would land on an unreset ladder.
    /// </summary>
    [Fact]
    public void Min_uptime_is_longer_than_the_ladders_stability_window()
    {
        Assert.True(ResourceCeiling.MinUptime > RestartPolicy.Default.StabilityWindow);
    }

    /// <summary>Without a watchdog, "restart" means "exit and stay gone until the next logon".</summary>
    [Fact]
    public void Without_a_watchdog_it_only_reports()
    {
        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = 217_431 }) with
        {
            Quiet = true,
            WatchdogPresent = false,
        });

        Assert.Equal(CeilingAction.ReportOnly, d.Action);
        Assert.Equal(CeilingReason.NoWatchdog, d.Reason);
    }

    [Fact]
    public void Mid_shutdown_it_does_nothing_but_keeps_the_anchor()
    {
        var since = Mono.AddMinutes(-3);

        var d = ResourceCeiling.Decide(Busy(Healthy with { HandleCount = 217_431 }) with
        {
            Quiet = true,
            ShuttingDown = true,
            OverSince = since,
        });

        Assert.Equal(CeilingAction.None, d.Action);
        Assert.Equal(CeilingReason.ShuttingDown, d.Reason);
        Assert.Equal(since, d.OverSince);
    }

    /// <summary>An anchor from another clock (in the future) restarts the count instead of trusting it.</summary>
    [Fact]
    public void An_over_since_in_the_future_is_reset_to_now()
    {
        var d = ResourceCeiling.Decide(Busy(OverHandles) with { OverSince = Mono.AddHours(2) });

        Assert.Equal(Mono, d.OverSince);
        Assert.Equal(CeilingAction.Wait, d.Action);
    }

    // ── the contract with the server ────────────────────────────────────────

    /// <summary>
    /// The server accepts only bare names matching <c>^[A-Za-z0-9][A-Za-z0-9._-]*$</c>, at most 8,
    /// each at most 64 characters (HeartbeatDto). One that did not fit would 400 the heartbeat.
    /// </summary>
    [Fact]
    public void Every_watched_module_is_a_name_the_server_accepts()
    {
        Assert.InRange(ResourceCeiling.WatchedModules.Count, 1, 8);

        foreach (var name in ResourceCeiling.WatchedModules)
        {
            Assert.InRange(name.Length, 1, 64);
            Assert.Matches("^[a-z0-9][a-z0-9._-]*$", name);
        }
    }

    /// <summary>Copied by hand into resources.rules.ts and fleet.ts; this pins the numbers.</summary>
    [Fact]
    public void The_ceiling_numbers_match_the_server_and_web_copies()
    {
        Assert.Equal(20_000, ResourceCeiling.MaxHandles);
        Assert.Equal(1_610_612_736, ResourceCeiling.MaxPrivateBytes);
    }
}
