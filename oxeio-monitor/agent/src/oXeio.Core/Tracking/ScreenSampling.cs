namespace oXeio.Core.Tracking;

/// <summary>
/// <b>G46: when to take the screen fingerprint.</b> Pure rule, no Win32.
///
/// <b>This file was born from a real harm.</b> Fingerprints used to come only from the
/// screenshot slot, and <see cref="Capture.CaptureGate"/> allows screenshots <b>only while
/// ACTIVE</b>. So:
///
/// <code>
/// screen froze → IDLE → screenshots stop → no new fingerprint → "frozen" forever
/// </code>
///
/// If an employee took a break of more than ten minutes, the agent would show idle
/// <b>permanently</b> even after they came back and started working, until restarted. The
/// tool meant to catch cheating would cut an honest employee's whole day, a bigger harm
/// than the jiggler itself.
///
/// <b>Lesson:</b> the source of the information a decision uses must not depend on the
/// outcome of that decision. Otherwise the decision manufactures its own proof and there
/// is no way out.
/// </summary>
public static class ScreenSampling
{
    /// <summary>
    /// How often a fingerprint is taken in the normal state.
    ///
    /// Careful: this must be <b>well below</b> <see cref="ScreenActivity.StaleAfter"/>, or
    /// samples would go stale during ordinary work and the guard would be silently useless
    /// (60 s against 3 min: three times the room).
    /// </summary>
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);

    /// <summary>
    /// When the screen is frozen, <b>much more often</b>: this is where fairness lies.
    ///
    /// While frozen, the employee's counting is off. If they come back and really start
    /// working, that must be noticed <b>as fast as possible</b>, or every break would cost a
    /// minute of time, every day, for everyone.
    ///
    /// The cost is negligible: only the first monitor, no WebP encoding, and it runs only
    /// while the screen is frozen (nobody there, or someone cheating).
    /// </summary>
    public static readonly TimeSpan WhenFrozen = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Is it time to take a new fingerprint now?
    ///
    /// If the clock went back (NTP correction) the calculation is negative; then one is taken,
    /// because an extra sample does no harm, but samples stopping does.
    /// </summary>
    public static bool Due(DateTimeOffset now, DateTimeOffset? lastSampleAt, bool frozen)
    {
        if (lastSampleAt is null) return true;

        var since = now - lastSampleAt.Value;
        if (since < TimeSpan.Zero) return true;

        return since >= (frozen ? WhenFrozen : Interval);
    }

    /// <summary>
    /// Is taking a fingerprint permitted at all?
    ///
    /// <b>There is deliberately no <c>SegmentState</c> here</b>, and that is the whole reason for
    /// this file. <see cref="Capture.CaptureGate"/> has the ACTIVE condition (rightly: screenshots
    /// are stored and looked at). But a fingerprint is neither stored nor sent anywhere; it only
    /// answers one question: <i>is the screen changing?</i> If the answer to that question
    /// depended on the state, a deadlock would arise.
    ///
    /// Three conditions remain, all as strict as for screenshots:
    ///   - signed in and not revoked: otherwise it is not known whose screen it is
    ///   - inside the section 4.2 window: outside office hours the screen is not touched at all
    ///   - <b>not locked</b>: a locked screen is still anyway, and keeping it as a sample would
    ///     make the screen look "frozen" for a while even after unlocking
    /// </summary>
    public static bool Allowed(bool enrolled, bool revoked, bool insideWindow, bool locked) =>
        enrolled && !revoked && insideWindow && !locked;
}
