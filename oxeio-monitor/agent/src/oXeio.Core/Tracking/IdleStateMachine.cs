using oXeio.Core.Models;
using oXeio.Core.Time;

namespace oXeio.Core.Tracking;

/// <summary>
/// The heart of the system: the whole rule is here.
///
/// <code>
/// keyboard/mouse in use?  →  yes: counting  ·  no (60 s): hold
/// </code>
///
/// Deliberately <b>platform-free</b>: there are no Win32 calls here. From outside it needs only
/// three facts: "what time is it now", "how long since the last input", and "is it locked".
/// So the whole rule can be verified in unit tests and also runs on Linux in CI (the real
/// <c>GetLastInputInfo</c> lives in oXeio.Agent).
/// </summary>
public sealed class IdleStateMachine
{
    /// <summary>Input within less than this counts that second as "active" (input score).</summary>
    private static readonly TimeSpan RecentInput = TimeSpan.FromSeconds(2);

    /// <summary>
    /// The longest a segment may stay open.
    ///
    /// <b>Why needed:</b> a segment closes only when the state changes. If someone works
    /// continuously (or keeps moving the mouse while watching a video), a single ACTIVE
    /// segment would stay open for hours and <b>nothing would reach the queue</b>.
    ///
    /// Then on a power cut or PC crash that whole stretch would be lost, because
    /// <see cref="CloseAll"/> runs only on a normal shutdown.
    /// On a real machine this showed up as zero segments on the server after 3 minutes of
    /// continuous work.
    ///
    /// 5 minutes was chosen because the screenshot slot is 5 minutes too: the two run on the
    /// same rhythm, and the most that a crash can lose is bounded to 5 minutes.
    /// </summary>
    public static readonly TimeSpan MaxSegmentLength = TimeSpan.FromMinutes(5);

    private readonly TimeSpan _idleThreshold;
    private readonly TimeSpan _maxSegment;
    private readonly Func<Guid> _newUuid;

    /// <summary>
    /// <b>G160: this object is mutated from several threads.</b>
    ///
    /// <b>The bug this fixes:</b> a comment in <c>AgentHost</c> said "<c>_machine</c> belongs
    /// to this loop", and that was <b>not true</b>. Three threads changed it:
    /// <list type="number">
    ///   <item><c>oXeio-tracker</c>: <see cref="Tick"/> every second;</item>
    ///   <item>the <b>WinForms message pump</b>: on <c>WM_POWERBROADCAST</c>,
    ///     <c>AgentHost.OnPower</c> calls <see cref="OnSuspend"/>/<see cref="OnResume"/>
    ///     directly, with no marshalling;</item>
    ///   <item>a <b>thread-pool thread</b>: <c>DisposeAsync</c> calls <see cref="CloseAll"/>
    ///     just when the tracker may be midway through a tick.</item>
    /// </list>
    ///
    /// <b>What happens when two enter <c>EmitAndReopen</c> together:</b> both read
    /// <c>_state == Active, _openedAt == T0</c>, then both build a segment for <b>the same
    /// stretch of time</b>, each with its own <c>ClientUuid</c>. The server trims duplicates
    /// only by <c>client_uuid</c>, not by overlap, so <b>that time is counted twice and paid
    /// twice</b>.
    ///
    /// An even worse side: <c>_state = next</c> and <c>_openedAt = at</c> are two separate
    /// writes. If one thread's <c>_openedAt</c> got paired with another's <c>_state</c>, time
    /// spent asleep could become <c>Active</c>.
    ///
    /// The lock is <b>here</b>, not in <c>AgentHost</c>: the guard belongs to the object that
    /// owns the rule. If a caller changes or a new one appears, the guard comes along by itself.
    ///
    /// The lock is held for less than a microsecond, with no I/O. This matters: <c>OnPower</c>
    /// runs on the message pump, where Windows gives only about 2 seconds before sleeping.
    /// <b>Sending the segment to the queue (<c>Record</c>) is outside the lock</b>, because it
    /// writes to SQLite.
    /// </summary>
    private readonly object _gate = new();

    private SegmentState _state;
    private DateTimeOffset _openedAt;
    private int _samples;
    private int _activeSamples;

    public IdleStateMachine(
        TimeSpan idleThreshold,
        DateTimeOffset startedAt,
        SegmentState initial = SegmentState.Active,
        Func<Guid>? newUuid = null,
        TimeSpan? maxSegment = null)
    {
        if (idleThreshold <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(idleThreshold));

        _idleThreshold = idleThreshold;
        _maxSegment = maxSegment ?? MaxSegmentLength;

        if (_maxSegment <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(maxSegment));

        _openedAt = startedAt;
        _state = initial;
        _newUuid = newUuid ?? Guid.NewGuid;
    }

    public SegmentState State { get { lock (_gate) return _state; } }
    public DateTimeOffset OpenedAt { get { lock (_gate) return _openedAt; } }

    /// <summary>
    /// State and "when it opened", <b>together, under one lock</b> <i>(G160)</i>.
    ///
    /// Reading the two properties separately lets a transition happen in between, pairing one
    /// reading's state with the other's time. The tray's "work done today" uses exactly this pair.
    /// </summary>
    public (SegmentState State, DateTimeOffset OpenedAt) Peek()
    {
        lock (_gate) return (_state, _openedAt);
    }

    /// <summary>Called every 1 second.</summary>
    /// <param name="now">The time on the monotonic clock (<see cref="MonotonicClock"/>).</param>
    /// <param name="sinceLastInput">How long since the last keyboard/mouse input.</param>
    /// <param name="locked">Whether the screen is locked (Win+L).</param>
    /// <param name="screenFrozen">
    /// <b>G46</b>: the screen has not changed at all for a long time
    /// (<see cref="ScreenActivity"/>). Even if the input timer says "active", when this is true
    /// time is not counted.
    ///
    /// This parameter is deliberately <b>not optional</b>. With a default, someone would one day
    /// write a new caller and forget to pass it, and the guard would be <b>silently</b> off.
    /// The mistake "the contract is written, the caller was not" has happened nine times in
    /// this project; putting the compiler on guard is the only real remedy.
    /// </param>
    /// <returns>The segments that closed on this tick.</returns>
    public IReadOnlyList<ActivitySegment> Tick(
        DateTimeOffset now,
        TimeSpan sinceLastInput,
        bool locked,
        bool screenFrozen)
    {
        lock (_gate) return TickCore(now, sinceLastInput, locked, screenFrozen);
    }

    private IReadOnlyList<ActivitySegment> TickCore(
        DateTimeOffset now,
        TimeSpan sinceLastInput,
        bool locked,
        bool screenFrozen)
    {
        var closed = new List<ActivitySegment>();

        // 1. After midnight the record is split even if the state did not change (section 2.1(a))
        SplitAtMidnights(closed, now);

        // 2. Split after a long time in the same state too, or the stretch of continuous work
        //    would stay open in memory instead of reaching the queue, and be lost in a crash.
        SplitLongSegments(closed, now);

        if (locked)
        {
            if (_state != SegmentState.Locked) Transition(closed, SegmentState.Locked, now);
            return closed;
        }

        /**
         * <b>G46: fake input.</b> When the screen is frozen, the input timer is no longer trusted.
         *
         * This is matched <b>together with the idle condition</b>, and no separate state was
         * created, because the result is the same: the time does not count as work. A new state
         * would mean adding a new field to the server, the screen and the reports, and it would
         * be missed somewhere.
         *
         * But there is <b>no</b> retro-adjust here. The screen was found frozen now, yet it may
         * have been frozen for ten minutes; cutting back ten minutes would also cut an honest
         * employee's reading time. So the cutting starts <b>from now</b> and the earlier part
         * is let go. When in doubt, erring in the employee's favor is the rule (the same
         * reasoning as ADR-023).
         */
        var untrusted = sinceLastInput >= _idleThreshold || screenFrozen;

        if (untrusted)
        {
            if (_state == SegmentState.Active)
            {
                // Retro-adjust (B04): idle actually started a threshold earlier, so that
                // stretch is excluded from the work count too: not one second more, not less.
                //
                // Only for **real** idle. If it is due to a frozen screen there is no cutting
                // back; see the comment above.
                var startedIdleAt = sinceLastInput >= _idleThreshold
                    ? now - _idleThreshold
                    : now;
                if (startedIdleAt < _openedAt) startedIdleAt = _openedAt;
                Transition(closed, SegmentState.Idle, startedIdleAt);
            }
            else if (_state == SegmentState.Locked)
            {
                // Unlocked, but nobody has touched anything yet: straight from LOCKED to IDLE.
                // No retro-adjust here: the locked time was never counted anyway.
                Transition(closed, SegmentState.Idle, now);
            }
        }
        else if (_state != SegmentState.Active)
        {
            // As soon as input arrives (B03): no waiting
            Transition(closed, SegmentState.Active, now);
        }

        if (_state == SegmentState.Active)
        {
            _samples++;
            if (sinceLastInput < RecentInput) _activeSamples++;
        }

        return closed;
    }

    /// <summary>
    /// The PC is going to sleep (G3). The open segment is closed right here, or after waking
    /// the whole time spent asleep would be added as work.
    /// </summary>
    public IReadOnlyList<ActivitySegment> OnSuspend(DateTimeOffset at)
    {
        lock (_gate)
        {
            var closed = new List<ActivitySegment>();
            Transition(closed, SegmentState.Locked, at);
            return closed;
        }
    }

    /// <summary>Woke up. IDLE until input arrives, so sleep time is not counted.</summary>
    public IReadOnlyList<ActivitySegment> OnResume(DateTimeOffset at)
    {
        lock (_gate)
        {
            var closed = new List<ActivitySegment>();
            // Close the sleep stretch as LOCKED and start a new day (split if midnight passed)
            EmitAndReopen(closed, SegmentState.Idle, at);
            return closed;
        }
    }

    /// <summary>logoff / shutdown / agent stopping: close the last segment.</summary>
    public IReadOnlyList<ActivitySegment> CloseAll(DateTimeOffset at)
    {
        lock (_gate)
        {
            var closed = new List<ActivitySegment>();
            EmitSegment(closed, _state, _openedAt, at);

            // `_openedAt` does not move back even if the clock goes back, or the next segment
            // would sit inside the previous one and overlap it (G160).
            if (at > _openedAt) _openedAt = at;
            ResetScore();
            return closed;
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private void Transition(List<ActivitySegment> closed, SegmentState next, DateTimeOffset at)
    {
        if (next == _state) return;
        EmitAndReopen(closed, next, at);
    }

    private void EmitAndReopen(List<ActivitySegment> closed, SegmentState next, DateTimeOffset at)
    {
        if (at < _openedAt) at = _openedAt;

        EmitSegment(closed, _state, _openedAt, at);
        _state = next;
        _openedAt = at;
        ResetScore();
    }

    /// <summary>
    /// Once an open segment passes <see cref="MaxSegmentLength"/>, it is cut there and reopened.
    /// The state does not change; only the record becomes durable.
    ///
    /// <b>The last <c>idleThreshold</c> stretch is never closed.</b>
    ///
    /// The reason is the retro-adjust (B04): when going from ACTIVE to IDLE, the last 60
    /// seconds must be <b>excluded</b> from the work count. If those 60 seconds have already
    /// gone out as a separate segment, they can no longer be cut back, and the idle time would
    /// silently be <b>counted as work</b>.
    ///
    /// So the split boundary is always kept before <c>now - idleThreshold</c>. The segment
    /// then comes out about 60 seconds late, which is no problem.
    /// </summary>
    private void SplitLongSegments(List<ActivitySegment> closed, DateTimeOffset now)
    {
        var horizon = now - _idleThreshold;

        while (_openedAt + _maxSegment <= horizon)
        {
            var boundary = _openedAt + _maxSegment;
            EmitSegment(closed, _state, _openedAt, boundary);
            _openedAt = boundary;
            ResetScore();
        }
    }

    /// <summary>When an open segment crosses midnight it is cut there and reopened.</summary>
    private void SplitAtMidnights(List<ActivitySegment> closed, DateTimeOffset now)
    {
        var boundary = DhakaTime.NextLocalMidnight(_openedAt);
        while (boundary <= now)
        {
            EmitSegment(closed, _state, _openedAt, boundary);
            _openedAt = boundary;
            ResetScore();
            boundary = DhakaTime.NextLocalMidnight(_openedAt);
        }
    }

    /// <summary>
    /// As a safeguard the split at midnight is done here too, so that no segment ever spans two
    /// work_dates.
    /// </summary>
    private void EmitSegment(
        List<ActivitySegment> closed,
        SegmentState state,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        if (to <= from) return;

        var score = ScoreFor(state);
        var cursor = from;

        while (cursor < to)
        {
            var boundary = DhakaTime.NextLocalMidnight(cursor);
            var end = boundary < to ? boundary : to;

            closed.Add(new ActivitySegment
            {
                ClientUuid = _newUuid(),
                State = state,
                StartedAt = cursor,
                EndedAt = end,
                DurationSec = (int)Math.Round((end - cursor).TotalSeconds),
                InputScore = score,
            });

            cursor = end;
        }
    }

    /// <summary>0 to 100. How busy the person was, not what they typed (B13).</summary>
    private int? ScoreFor(SegmentState state)
    {
        if (state != SegmentState.Active || _samples == 0) return null;
        return (int)Math.Round(100.0 * _activeSamples / _samples);
    }

    private void ResetScore()
    {
        _samples = 0;
        _activeSamples = 0;
    }
}
