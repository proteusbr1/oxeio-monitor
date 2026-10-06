namespace oXeio.Core.Agent;

/// <summary>
/// <b>What</b> changed between two configs: pure computation, no side effects.
///
/// <b>Why a separate type:</b> applying a config happens in <c>AgentHost</c>, where Win32,
/// threads and the tray are all tangled together, so "what must be done when X changes" cannot
/// be verified there. With the decision here, every branch can be covered by unit tests.
///
/// <b>Do not touch what did not change.</b> That is the whole reason for this type. Changing
/// the idle threshold means closing the current segment; changing app tracking means closing
/// the open record. If the code were "a config arrived, reset everything", then whenever
/// someone pressed **Save** in the server's Settings, the segments on all 15 PCs would be cut
/// for no reason, and a few times a day that would fill the reports with fragment rows.
/// </summary>
public readonly record struct ConfigChange
{
    /// <summary>A04b: the screenshot time window (<c>07:00–23:00</c>).</summary>
    public bool CaptureWindow { get; init; }

    /// <summary>A01: the slot length.</summary>
    public bool Slots { get; init; }

    /// <summary>D01–D04: app tracking was switched on/off.</summary>
    public bool AppTrackingToggled { get; init; }

    /// <summary>D04: how short a duration is ignored.</summary>
    public bool AppMinDuration { get; init; }

    /// <summary>B02: the idle limit. Careful: the most expensive change.</summary>
    public bool IdleThreshold { get; init; }

    /// <summary>Heartbeat interval: takes effect from the next delay, nothing needs closing.</summary>
    public bool Heartbeat { get; init; }

    /// <summary>Did anything change at all?</summary>
    public bool Any =>
        CaptureWindow || Slots || AppTrackingToggled || AppMinDuration || IdleThreshold || Heartbeat;

    /// <summary>
    /// Whether the current segment or open record must be closed, i.e. the change is not
    /// "free".
    /// </summary>
    public bool TouchesTracking => IdleThreshold || AppTrackingToggled || AppMinDuration;

    public static ConfigChange Between(AgentConfig old, AgentConfig now)
    {
        ArgumentNullException.ThrowIfNull(old);
        ArgumentNullException.ThrowIfNull(now);

        return new ConfigChange
        {
            // Strings are compared Ordinal: "07:00" and "7:00" are different values, and a
            // culture-sensitive comparison is meaningless here.
            CaptureWindow =
                !string.Equals(old.ScreenshotFrom, now.ScreenshotFrom, StringComparison.Ordinal) ||
                !string.Equals(old.ScreenshotTo, now.ScreenshotTo, StringComparison.Ordinal),

            // A zero or negative slot does not count as a "change": SlotScheduler would reject
            // it, and one bad config would take the whole capture loop down.
            Slots = now.SlotMinutes > 0 && now.SlotMinutes != old.SlotMinutes,

            AppTrackingToggled = old.AppTracking.Enabled != now.AppTracking.Enabled,

            // Meaningful only while enabled: when off, there is nothing to close to change
            // the limit.
            AppMinDuration =
                now.AppTracking.Enabled &&
                old.AppTracking.Enabled &&
                old.AppTracking.MinDurationSec != now.AppTracking.MinDurationSec,

            IdleThreshold = now.IdleThresholdSec > 0 && now.IdleThresholdSec != old.IdleThresholdSec,

            Heartbeat = now.HeartbeatSec > 0 && now.HeartbeatSec != old.HeartbeatSec,
        };
    }
}
