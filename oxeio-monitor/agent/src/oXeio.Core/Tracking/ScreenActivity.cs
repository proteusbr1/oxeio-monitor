namespace oXeio.Core.Tracking;

/// <summary>
/// <b>G46: is the screen really changing?</b> Pure rule, no Win32.
///
/// <b>Why this is needed:</b> the agent measures idle with <c>GetLastInputInfo</c>, and that
/// API <b>cannot tell real input from fake</b>. A ten-line script that does
/// <c>SendKeys("{F15}")</c> every minute resets the timer forever while nothing shows on the
/// screen. The result is "Working" all day, a direct loss to the office.
///
/// The idea behind the fix is simple: <b>when someone is really working the screen changes</b>:
/// characters appear, the cursor moves, windows shift. When a jiggler runs the screen is
/// completely still and only a timer is reset.
///
/// <b>No low-level hook is used, deliberately.</b> Looking at <c>LLKHF_INJECTED</c> would
/// catch fake keystrokes for certain, but that is a keylogger's tool and is explicitly
/// forbidden in 04-Features § L. What is looked at here is <b>whether the screen's shape
/// changed</b>, not what was typed. The hash never leaves the machine.
///
/// This is not perfect: if someone leaves a clock or a video open on screen, the screen keeps
/// changing. But that is noticed at once in the screenshots, and the server's
/// <c>synthetic_input</c> alert runs alongside; together they raise the cost of cheating a lot.
/// </summary>
public sealed class ScreenActivity
{
    /// <summary>
    /// If the screen does not change at all for this long, it is considered "frozen".
    ///
    /// The number is <b>generous</b>, deliberately. People read long documents, think, talk on
    /// the phone, and the screen can stay still for several minutes. A lower value would cut an
    /// honest employee's hours, and <b>that mistake does far more harm than failing to catch
    /// cheating</b>.
    ///
    /// With 10 minutes a jiggler can steal at most those 10 minutes before counting stops:
    /// 10 minutes at most instead of 8 hours a day.
    /// </summary>
    public static readonly TimeSpan FrozenAfter = TimeSpan.FromMinutes(10);

    /// <summary>
    /// <b>How much one cell must change to count as "changed".</b>
    ///
    /// The fingerprint is grayscale, so values are 0 to 255. Small variations are always
    /// present: JPEG/WebP compensation, cursor flicker, anti-aliasing. With zero tolerance
    /// the screen would <b>never</b> freeze.
    /// </summary>
    private const int CellTolerance = 12;

    /// <summary>
    /// <b>How many cells must change for the screen to truly count as "changed".</b>
    ///
    /// This is the <b>most important number in this file</b>, and the reason is very real:
    /// <b>the taskbar clock changes every minute.</b> If an exact match were required, a
    /// single digit of the clock would be enough, the screen would always look "changing", and
    /// the whole guard would be <b>silently useless</b>. Exactly this kind of silently useless
    /// feature has kept returning in this project.
    ///
    /// In 16x16 = 256 cells a clock touches at most 1 or 2 cells. At 6, a clock, a
    /// notification dot or a blinking cursor does not get through, but real work (scrolling,
    /// typing, switching windows) easily exceeds the limit.
    /// </summary>
    private const int ChangedCells = 6;

    /// <summary>
    /// <b>If the sample is this old, no answer is given any more.</b>
    ///
    /// <b>This came from a real incident</b>, not from theory. In the first version the
    /// fingerprint came <b>only from the screenshot slot</b>, and screenshots are taken only
    /// while ACTIVE. That produced a deadlock:
    ///
    /// <code>
    /// screen froze → IDLE → screenshots stop → no new fingerprint → "frozen" forever
    /// </code>
    ///
    /// Even when the employee came back and started working, the agent would show idle
    /// <b>permanently</b>, until the agent was restarted. The very tool meant to catch
    /// cheating would cut an honest employee's whole day. This very risk was even written at
    /// the top of the test file, but the mistake was in the <b>wiring</b>, not in the rule, so
    /// no unit test could catch it.
    ///
    /// So the rule now guards itself: if the sample is not fresh the answer is "don't know",
    /// and don't know does not mean suspicion. However a caller is written, the deadlock can
    /// no longer arise.
    /// </summary>
    public static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(3);

    private readonly TimeSpan _frozenAfter;
    private readonly TimeSpan _staleAfter;

    /**
     * <b>Written by the capture loop, read by the tracker thread.</b> Without a lock, reading a
     * <see cref="DateTimeOffset"/> (12+ bytes) could tear: half old, half new, giving a bogus
     * time, i.e. a wrongful "frozen" or a wrongful "stale". Perhaps once a year, and almost
     * impossible to catch.
     *
     * The cost is negligible: it is called at most once a second.
     */
    private readonly object _gate = new();

    /**
     * <b>One fingerprint per monitor.</b> There used to be a single <c>byte[]</c>, for the
     * first screen only, and that is what cut honest employees' hours in the field (see the
     * note on <see cref="DiffersAny"/> below).
     */
    private byte[][]? _last;
    private DateTimeOffset _changedAt;

    /// <summary>When the last sample arrived, whether it changed or not.</summary>
    private DateTimeOffset _sampledAt;

    public ScreenActivity(TimeSpan? frozenAfter = null, TimeSpan? staleAfter = null)
    {
        var window = frozenAfter ?? FrozenAfter;
        if (window <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(frozenAfter));

        var stale = staleAfter ?? StaleAfter;
        if (stale <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(staleAfter));

        _frozenAfter = window;
        _staleAfter = stale;
    }

    /// <summary>
    /// Are two fingerprints really different? Pure, so it can be tested.
    ///
    /// If the sizes differ it counts as "changed" (a monitor was added or removed).
    /// </summary>
    public static bool Differs(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return true;

        var moved = 0;
        for (var i = 0; i < a.Length; i++)
        {
            if (Math.Abs(a[i] - b[i]) > CellTolerance && ++moved >= ChangedCells)
                return true;
        }

        return false;
    }

    /// <summary>
    /// <b>If <i>any one</i> of several screens changes, it counts as "changed".</b>
    ///
    /// <b>This is the bug fixed on 31 August 2026.</b> The fingerprint was taken only from the
    /// <b>first</b> monitor (<c>CapturePrimary()</c>), so when someone worked on the second
    /// screen the first stayed still → after ten minutes "frozen" → counting stopped.
    /// Measured in the field over two days: 43, 9 and 6 bogus idles on three two-monitor PCs,
    /// and <b>zero</b> on six one-monitor PCs.
    ///
    /// The old code's note argued the <b>opposite</b>: that comparing all screens would let an
    /// idle second monitor alone count as frozen and stop counting. That would be true only if
    /// the rule were inverted. The correct rule: <b>a change on any one = work is happening</b>;
    /// so an idle second monitor can never stop counting, and the jiggler guard stays intact
    /// (when a jiggler runs <b>no</b> screen changes).
    ///
    /// If the count differs it counts as "changed": a monitor was added or removed, meaning
    /// someone touched the machine.
    /// </summary>
    public static bool DiffersAny(
        IReadOnlyList<byte[]> before, IReadOnlyList<byte[]> after)
    {
        if (before.Count != after.Count) return true;

        for (var i = 0; i < before.Count; i++)
        {
            if (Differs(before[i], after[i])) return true;
        }

        return false;
    }

    /// <summary>
    /// A new sample of the screen.
    ///
    /// The first sample <b>counts as a change</b>: there was nothing to compare with before, and
    /// treating "don't know" as "unchanged" would stop everyone's counting within the first ten
    /// minutes after the agent started.
    /// </summary>
    public void Observe(byte[] fingerprint, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(fingerprint);

        Observe([fingerprint], now);
    }

    /// <summary>
    /// One fingerprint per monitor. The order is fixed (monitor order), so the same index
    /// means the same screen.
    /// </summary>
    public void Observe(IReadOnlyList<byte[]> fingerprints, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(fingerprints);
        if (fingerprints.Count == 0) return;

        lock (_gate)
        {
            // Whether it changed or not, a sample arrived, and that is remembered separately.
            // "When did it last change" and "when did I last look" are two different questions,
            // and not keeping the answer to the second was the root of the deadlock.
            _sampledAt = now;

            if (_last is null || DiffersAny(_last, fingerprints))
            {
                // A copy: if the caller reused the list later, our "last seen" would change
                // silently.
                _last = [.. fingerprints];
                _changedAt = now;
            }
        }
    }

    /// <summary>
    /// With no sample at all, <b>false</b>: no suspicion.
    ///
    /// Capture can be off (at night, outside the section 4.2 window), can fail, or the agent
    /// may have just started. Treating that as "screen unchanged" would make <b>the lack of
    /// information itself the punishment</b>; the server's G46 rule takes exactly the same decision.
    /// </summary>
    public bool IsFrozen(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_last is null) return false;

            /**
             * <b>No accusation without a fresh sample</b> (<see cref="StaleAfter"/>).
             *
             * Samples can stop arriving for any reason: capture failing, a monitor unplugged, the
             * section 4.2 window closed, the screen locked. Treating that silence as "screen
             * unchanged" would make <b>the lack of information itself the punishment</b>, and
             * once caught there would be no way out.
             */
            if (now - _sampledAt > _staleAfter) return false;

            // If the clock went back (NTP correction) it can be negative: still "not frozen"
            return now - _changedAt >= _frozenAfter;
        }
    }

    /// <summary>When the screen last changed: for showing in the log. Null if there are no samples.</summary>
    public DateTimeOffset? LastChangedAt
    {
        get { lock (_gate) { return _last is null ? null : _changedAt; } }
    }

    /// <summary>When a sample last arrived: for understanding "why it did not freeze" in diagnostics.</summary>
    public DateTimeOffset? LastSampledAt
    {
        get { lock (_gate) { return _last is null ? null : _sampledAt; } }
    }
}
