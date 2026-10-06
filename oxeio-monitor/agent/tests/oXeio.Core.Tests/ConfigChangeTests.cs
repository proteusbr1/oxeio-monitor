using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// E09 / K07: what the agent touches when settings change on the server.
///
/// Careful: these rules have a cost. When <see cref="ConfigChange.TouchesTracking"/>
/// is true the agent closes the current segment and starts a new one. If it wrongly
/// always returned true, pressing **save** in Settings would cut everyone's segment
/// on all 15 PCs.
/// </summary>
public class ConfigChangeTests
{
    private static AgentConfig Base => AgentConfig.Default;

    [Fact]
    public void An_identical_config_changes_nothing()
    {
        var change = ConfigChange.Between(Base, Base with { });

        Assert.False(change.Any);
        Assert.False(change.TouchesTracking);
    }

    /// <summary>
    /// The most important test: changing an irrelevant field does not touch tracking.
    /// Changing the monthly target or the timezone is not a reason to cut anyone's segment.
    /// </summary>
    [Fact]
    public void Changing_the_monthly_target_does_not_touch_tracking()
    {
        var change = ConfigChange.Between(Base, Base with { MonthlyTargetHours = 180 });

        Assert.False(change.Any);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void Changing_the_screenshot_time_range_only_affects_the_window()
    {
        var change = ConfigChange.Between(Base, Base with { ScreenshotTo = "21:00" });

        Assert.True(change.CaptureWindow);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void Changing_the_slot_does_not_touch_tracking()
    {
        var change = ConfigChange.Between(Base, Base with { SlotMinutes = 10 });

        Assert.True(change.Slots);
        Assert.False(change.TouchesTracking);
    }

    /// <summary>
    /// Careful: a zero slot is not a "change"; <c>SlotScheduler</c> throws on it, and
    /// one bad config would bring down the whole capture loop.
    /// </summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void An_invalid_slot_is_ignored(int minutes)
    {
        var change = ConfigChange.Between(Base, Base with { SlotMinutes = minutes });

        Assert.False(change.Slots);
    }

    [Fact]
    public void Changing_the_idle_threshold_touches_tracking()
    {
        var change = ConfigChange.Between(Base, Base with { IdleThresholdSec = 120 });

        Assert.True(change.IdleThreshold);
        Assert.True(change.TouchesTracking);
    }

    /// <summary>
    /// Careful: a zero limit would mean "idle every second"; if set by mistake it is ignored.
    /// </summary>
    [Fact]
    public void A_zero_idle_threshold_is_ignored()
    {
        var change = ConfigChange.Between(Base, Base with { IdleThresholdSec = 0 });

        Assert.False(change.IdleThreshold);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void Turning_app_tracking_off_touches_tracking()
    {
        var change = ConfigChange.Between(
            Base,
            Base with { AppTracking = new AppTrackingConfig { Enabled = false, MinDurationSec = 5 } });

        Assert.True(change.AppTrackingToggled);
        Assert.True(change.TouchesTracking);
    }

    /// <summary>
    /// Careful: changing the limit while stopped is meaningless; there is no open
    /// record to close. Returning true by mistake would make the agent call `CloseAll` for nothing.
    /// </summary>
    [Fact]
    public void A_limit_change_while_app_tracking_is_off_does_not_count()
    {
        var off = new AppTrackingConfig { Enabled = false, MinDurationSec = 5 };
        var offLonger = new AppTrackingConfig { Enabled = false, MinDurationSec = 30 };

        var change = ConfigChange.Between(
            Base with { AppTracking = off },
            Base with { AppTracking = offLonger });

        Assert.False(change.AppMinDuration);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void A_heartbeat_change_does_not_touch_tracking()
    {
        var change = ConfigChange.Between(Base, Base with { HeartbeatSec = 45 });

        Assert.True(change.Heartbeat);
        Assert.True(change.Any);
        Assert.False(change.TouchesTracking);
    }
}
