using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>From what the agent knows about itself to the states in the heartbeat.</summary>
public class CapabilityReportTests
{
    private static IReadOnlyDictionary<string, CapabilityState> Report(CapabilityFacts f) =>
        CapabilityReport.Build(f);

    [Fact]
    public void A_healthy_agent_reports_ok_for_everything()
    {
        var r = Report(new CapabilityFacts());

        Assert.Equal(6, r.Count);
        Assert.All(r.Values, s => Assert.Equal(CapabilityState.Ok, s));
    }

    [Fact]
    public void Domain_reader_that_gave_up_is_degraded_not_ok()
    {
        var r = Report(new CapabilityFacts { BrowserDomainGaveUp = true });

        Assert.Equal(CapabilityState.Degraded, r[CapabilityReport.BrowserDomain]);
        // the app itself is still tracked
        Assert.Equal(CapabilityState.Ok, r[CapabilityReport.AppTracking]);
    }

    [Fact]
    public void Screenshots_off_by_policy_are_disabled_by_policy_and_the_jiggler_check_is_not()
    {
        var r = Report(new CapabilityFacts { ScreenshotsEnabledByPolicy = false });

        Assert.Equal(CapabilityState.DisabledByPolicy, r[CapabilityReport.ScreenCapture]);
        Assert.Equal(CapabilityState.Ok, r[CapabilityReport.ScreenActivity]);
    }

    [Fact]
    public void App_tracking_off_by_policy_takes_the_domain_with_it()
    {
        var r = Report(new CapabilityFacts { AppTrackingEnabledByPolicy = false, AppTrackerRunning = false });

        Assert.Equal(CapabilityState.DisabledByPolicy, r[CapabilityReport.AppTracking]);
        Assert.Equal(CapabilityState.DisabledByPolicy, r[CapabilityReport.BrowserDomain]);
    }

    [Fact]
    public void App_tracking_on_but_not_running_is_a_failure()
    {
        var r = Report(new CapabilityFacts { AppTrackerRunning = false });

        Assert.Equal(CapabilityState.Failed, r[CapabilityReport.AppTracking]);
    }

    [Theory]
    [InlineData(0, CapabilityState.Ok)]
    [InlineData(4, CapabilityState.Ok)]
    [InlineData(5, CapabilityState.Degraded)]
    [InlineData(60, CapabilityState.Failed)]
    public void Idle_probe_by_refused_readings(int streak, CapabilityState expected) =>
        Assert.Equal(expected, Report(new CapabilityFacts { IdleProbeFailStreak = streak })[CapabilityReport.IdleProbe]);

    [Theory]
    [InlineData(0, CapabilityState.Ok)]
    [InlineData(1, CapabilityState.Degraded)]
    [InlineData(3, CapabilityState.Failed)]
    public void Screenshots_by_empty_slots(int streak, CapabilityState expected) =>
        Assert.Equal(expected, Report(new CapabilityFacts { ScreenshotFailStreak = streak })[CapabilityReport.ScreenCapture]);

    [Theory]
    [InlineData(SyncHealth.Ok, CapabilityState.Ok)]
    [InlineData(SyncHealth.Degraded, CapabilityState.Degraded)]
    [InlineData(SyncHealth.Failing, CapabilityState.Failed)]
    [InlineData(SyncHealth.Revoked, CapabilityState.Failed)]
    public void Sync_follows_the_worker(SyncHealth health, CapabilityState expected) =>
        Assert.Equal(expected, Report(new CapabilityFacts { Sync = health })[CapabilityReport.SyncName]);

    [Fact]
    public void Wire_form_is_snake_case()
    {
        var wire = CapabilityReport.ToWire(Report(new CapabilityFacts
        {
            ScreenshotsEnabledByPolicy = false,
            BrowserDomainGaveUp = true,
            ScreenFingerprintFailed = true,
        }));

        Assert.Equal("disabled_by_policy", wire["screenCapture"]);
        Assert.Equal("degraded", wire["browserDomain"]);
        Assert.Equal("failed", wire["screenActivity"]);
        Assert.Equal("ok", wire["sync"]);
    }
}
