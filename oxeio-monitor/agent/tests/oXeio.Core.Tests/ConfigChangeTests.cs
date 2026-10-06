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
    public void একই_কনফিগে_কিছুই_বদলায়_না()
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
    public void মাসিক_টার্গেট_বদলালে_ট্র্যাকিং_ছোঁয়া_হয়_না()
    {
        var change = ConfigChange.Between(Base, Base with { MonthlyTargetHours = 180 });

        Assert.False(change.Any);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void ছবির_সময়সীমা_বদলালে_শুধু_উইন্ডো()
    {
        var change = ConfigChange.Between(Base, Base with { ScreenshotTo = "21:00" });

        Assert.True(change.CaptureWindow);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void স্লট_বদলালে_ট্র্যাকিং_ছোঁয়া_হয়_না()
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
    public void অবৈধ_স্লট_উপেক্ষা_করা_হয়(int minutes)
    {
        var change = ConfigChange.Between(Base, Base with { SlotMinutes = minutes });

        Assert.False(change.Slots);
    }

    [Fact]
    public void idle_সীমা_বদলালে_ট্র্যাকিং_ছুঁতে_হয়()
    {
        var change = ConfigChange.Between(Base, Base with { IdleThresholdSec = 120 });

        Assert.True(change.IdleThreshold);
        Assert.True(change.TouchesTracking);
    }

    /// <summary>
    /// Careful: a zero limit would mean "idle every second"; if set by mistake it is ignored.
    /// </summary>
    [Fact]
    public void শূন্য_idle_সীমা_উপেক্ষা_করা_হয়()
    {
        var change = ConfigChange.Between(Base, Base with { IdleThresholdSec = 0 });

        Assert.False(change.IdleThreshold);
        Assert.False(change.TouchesTracking);
    }

    [Fact]
    public void অ্যাপ_ট্র্যাকিং_বন্ধ_করা_ট্র্যাকিং_ছোঁয়()
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
    public void বন্ধ_থাকা_অ্যাপ_ট্র্যাকিংয়ে_সীমা_বদল_গোনা_হয়_না()
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
    public void heartbeat_বদল_ট্র্যাকিং_ছোঁয়_না()
    {
        var change = ConfigChange.Between(Base, Base with { HeartbeatSec = 45 });

        Assert.True(change.Heartbeat);
        Assert.True(change.Any);
        Assert.False(change.TouchesTracking);
    }
}
