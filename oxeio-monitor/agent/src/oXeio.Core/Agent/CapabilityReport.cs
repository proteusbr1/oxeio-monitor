namespace oXeio.Core.Agent;

/// <summary>How one part of the agent is doing, as sent in the heartbeat.</summary>
public enum CapabilityState
{
    Ok,

    /// <summary>Working, but not fully — e.g. the domain reader gave up on this PC.</summary>
    Degraded,

    /// <summary>Not working.</summary>
    Failed,

    /// <summary>Off because the work policy says so — not a fault.</summary>
    DisabledByPolicy,
}

/// <summary>
/// What the agent knows about its own parts, gathered by <c>AgentHost</c>.
/// Plain facts only — the verdicts are in <see cref="CapabilityReport"/>.
/// </summary>
public sealed record CapabilityFacts
{
    /// <summary>Consecutive idle-probe readings Windows refused (GetLastInputInfo).</summary>
    public int IdleProbeFailStreak { get; init; }

    public bool AppTrackingEnabledByPolicy { get; init; } = true;

    /// <summary>The app tracker exists — it is only built when the policy allows it.</summary>
    public bool AppTrackerRunning { get; init; } = true;

    /// <summary>The browser address-bar reader stopped trying after repeated failures.</summary>
    public bool BrowserDomainGaveUp { get; init; }

    public bool ScreenshotsEnabledByPolicy { get; init; } = true;

    /// <summary>Consecutive screenshot slots that produced no image or threw.</summary>
    public int ScreenshotFailStreak { get; init; }

    /// <summary>The screen fingerprint behind the jiggler check could not be taken.</summary>
    public bool ScreenFingerprintFailed { get; init; }

    public SyncHealth Sync { get; init; } = SyncHealth.Ok;
}

/// <summary>
/// The capability report in the heartbeat: one state per part of the agent.
///
/// ⚠️ Why it exists: several parts fail on their own and quietly — the domain
/// reader switches itself off after 20 failures, the screen fingerprint stops
/// on a PC where capture is broken — and the dashboard went on looking normal.
/// The project's rule is never to claim what it does not know; a part that
/// stopped working has to say so.
///
/// ⚠️ No "watchdog" entry: the agent cannot see its own watchdog, and a
/// report that guessed would break the same rule.
/// </summary>
public static class CapabilityReport
{
    public const string IdleProbe = "idleProbe";
    public const string AppTracking = "appTracking";
    public const string BrowserDomain = "browserDomain";
    public const string ScreenCapture = "screenCapture";
    public const string ScreenActivity = "screenActivity";
    public const string SyncName = "sync";

    /// <summary>A few refused readings happen (session switch, UAC prompt); a minute of them does not.</summary>
    public const int IdleProbeDegradedAfter = 5;
    public const int IdleProbeFailedAfter = 60;

    /// <summary>One empty slot can be a locked desktop racing the capture; three in a row are not.</summary>
    public const int ScreenshotFailedAfter = 3;

    public static IReadOnlyDictionary<string, CapabilityState> Build(CapabilityFacts f)
    {
        ArgumentNullException.ThrowIfNull(f);

        var appTracking =
            !f.AppTrackingEnabledByPolicy ? CapabilityState.DisabledByPolicy
            : f.AppTrackerRunning ? CapabilityState.Ok
            : CapabilityState.Failed;

        return new Dictionary<string, CapabilityState>(StringComparer.Ordinal)
        {
            [IdleProbe] =
                f.IdleProbeFailStreak >= IdleProbeFailedAfter ? CapabilityState.Failed
                : f.IdleProbeFailStreak >= IdleProbeDegradedAfter ? CapabilityState.Degraded
                : CapabilityState.Ok,

            [AppTracking] = appTracking,

            // the domain comes from the app tracker; without it there is nothing to read
            [BrowserDomain] =
                appTracking != CapabilityState.Ok ? appTracking
                : f.BrowserDomainGaveUp ? CapabilityState.Degraded
                : CapabilityState.Ok,

            [ScreenCapture] =
                !f.ScreenshotsEnabledByPolicy ? CapabilityState.DisabledByPolicy
                : f.ScreenshotFailStreak >= ScreenshotFailedAfter ? CapabilityState.Failed
                : f.ScreenshotFailStreak > 0 ? CapabilityState.Degraded
                : CapabilityState.Ok,

            // ⚠️ never "disabled by policy": the jiggler check runs whatever the
            //    screenshot setting is
            [ScreenActivity] = f.ScreenFingerprintFailed ? CapabilityState.Failed : CapabilityState.Ok,

            [SyncName] = f.Sync switch
            {
                SyncHealth.Ok => CapabilityState.Ok,
                SyncHealth.Degraded => CapabilityState.Degraded,
                _ => CapabilityState.Failed,
            },
        };
    }

    /// <summary>The wire form: <c>ok</c> · <c>degraded</c> · <c>failed</c> · <c>disabled_by_policy</c>.</summary>
    public static string ToWire(CapabilityState state) => state switch
    {
        CapabilityState.Ok => "ok",
        CapabilityState.Degraded => "degraded",
        CapabilityState.Failed => "failed",
        CapabilityState.DisabledByPolicy => "disabled_by_policy",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, null),
    };

    public static IReadOnlyDictionary<string, string> ToWire(IReadOnlyDictionary<string, CapabilityState> report) =>
        report.ToDictionary(kv => kv.Key, kv => ToWire(kv.Value), StringComparer.Ordinal);
}
