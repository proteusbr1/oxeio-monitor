using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Capture;

/// <summary>
/// Whether a picture is taken: the conditions, all in one place.
///
/// <b>Why a separate type:</b> the conditions were spread as guard clauses inside
/// <c>AgentHost.CaptureSlotAsync</c>, where they could not be verified (Win32, threads, disk,
/// all tangled together). So even if a condition was <b>missing</b>, no test would catch it,
/// and that is exactly what happened: the <see cref="Revoked"/> condition was never written.
/// </summary>
public static class CaptureGate
{
    /// <summary>Why no picture was taken: useful in both logs and tests.</summary>
    public enum Verdict
    {
        Allowed,

        /// <summary>A04: no picture in any state other than ACTIVE.</summary>
        NotActive,

        /// <summary>A04b: outside 07:00-23:00. Time is still counted.</summary>
        OutsideWindow,

        /// <summary>
        /// H06: the device is revoked.
        ///
        /// <b>This condition was missing until now.</b> Revoking only stopped uploads; pictures
        /// were still taken and piled up on disk. So screenshots kept accumulating on a dismissed
        /// employee's PC, seen by nobody and going nowhere, but there. That defeats the whole
        /// point of revoking a device.
        /// </summary>
        Revoked,

        /// <summary>
        /// <b>This condition was missing too</b>, just like <see cref="Revoked"/>. Pictures
        /// were taken before sign-in, though there is no basis for storing any picture under the
        /// name of someone who has not even signed in yet
        /// (<see cref="oXeio.Core.Agent.TrackingGate"/>).
        /// </summary>
        NotEnrolled,

        /// <summary>
        /// The work policy turned screenshots off (<c>screenshot.enabled = false</c>).
        ///
        /// ⚠️ Only the screenshot is skipped. The screen fingerprint behind the
        /// jiggler check (<see cref="ScreenActivity"/>) is taken by
        /// <see cref="ScreenSampling"/> on its own schedule and never asks this
        /// gate, so hours are counted exactly as with screenshots on.
        /// </summary>
        DisabledByPolicy,
    }

    public static Verdict Check(
        SegmentState state,
        bool enrolled,
        bool revoked,
        CaptureWindow window,
        DateTimeOffset fireAt,
        bool screenshotsEnabled = true)
    {
        ArgumentNullException.ThrowIfNull(window);

        // Sign-in and revoke come first: on a revoked or not-signed-in device, the answer to "why
        // was no picture taken" must not be "it was idle at the time".
        //
        // The order is **not written again** here; TrackingGate is the only source. Written
        // twice, the two would one day differ, and pictures and hours would follow different rules.
        switch (Agent.TrackingGate.Check(enrolled, revoked))
        {
            case Agent.TrackingGate.Verdict.Revoked: return Verdict.Revoked;
            case Agent.TrackingGate.Verdict.NotEnrolled: return Verdict.NotEnrolled;
            default: break;
        }

        // before NotActive/OutsideWindow: when the policy says "never", the
        // log should say that, not "idle at the time"
        if (!screenshotsEnabled) return Verdict.DisabledByPolicy;

        if (state != SegmentState.Active) return Verdict.NotActive;
        if (!window.Allows(fireAt)) return Verdict.OutsideWindow;

        return Verdict.Allowed;
    }

    public static bool Allows(
        SegmentState state,
        bool enrolled,
        bool revoked,
        CaptureWindow window,
        DateTimeOffset fireAt,
        bool screenshotsEnabled = true) =>
        Check(state, enrolled, revoked, window, fireAt, screenshotsEnabled) == Verdict.Allowed;
}
