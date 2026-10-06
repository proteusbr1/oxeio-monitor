using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// The points of the manual checklist in [02-Workflow § 9] that can be verified
/// automatically. The rest (screen capture, tray, AV) must be checked on a real desktop.
/// </summary>
public class IdleStateMachineTests
{
    private static readonly TimeSpan Threshold = TimeSpan.FromSeconds(60);
    private static readonly DateTimeOffset Start =
        new(2026, 8, 9, 4, 0, 0, TimeSpan.Zero); // 10 AM local (UTC+6 in tests)

    private static IdleStateMachine New(DateTimeOffset? at = null) =>
        new(Threshold, at ?? Start);

    /// <summary>Feeds input one second at a time (a person is working).</summary>
    private static List<ActivitySegment> Run(
        IdleStateMachine sm,
        DateTimeOffset from,
        int seconds,
        Func<int, TimeSpan> sinceLastInput,
        bool locked = false)
    {
        var all = new List<ActivitySegment>();
        for (var i = 1; i <= seconds; i++)
            all.AddRange(sm.Tick(from.AddSeconds(i), sinceLastInput(i), locked, screenFrozen: false));
        return all;
    }

    /// <summary>
    /// This test used to say "no segment closes while the person keeps working", and
    /// that was the bug: the continuous working time stayed open in memory instead of
    /// going to the queue, and would be lost on a power cut
    /// ([G53](../../../../docs/history/08-Gap-Analysis.md)).
    /// Now the state does not change, but records come out regularly.
    /// </summary>
    [Fact]
    public void Records_come_out_regularly_during_work_but_the_state_does_not_change()
    {
        var sm = New();
        var closed = Run(sm, Start, 600, _ => TimeSpan.Zero);

        Assert.NotEmpty(closed);
        Assert.All(closed, c => Assert.Equal(SegmentState.Active, c.State));
        Assert.Equal(SegmentState.Active, sm.State);
    }

    [Fact]
    public void The_timer_stops_at_exactly_60_seconds_of_inactivity()
    {
        var sm = New();

        // 5 minutes of work, then hands off
        Run(sm, Start, 300, _ => TimeSpan.Zero);
        var afterWork = Start.AddSeconds(300);

        var closed = Run(sm, afterWork, 59, i => TimeSpan.FromSeconds(i));
        Assert.Empty(closed); // still ACTIVE at 59 seconds

        closed = Run(sm, afterWork.AddSeconds(59), 1, _ => TimeSpan.FromSeconds(60));
        Assert.Single(closed);
        Assert.Equal(SegmentState.Idle, sm.State);
    }

    [Fact]
    public void Retro_adjust_cuts_back_exactly_60_seconds()
    {
        var sm = New();
        Run(sm, Start, 300, _ => TimeSpan.Zero);

        var closed = Run(sm, Start.AddSeconds(300), 60, i => TimeSpan.FromSeconds(i));

        var active = Assert.Single(closed);
        Assert.Equal(SegmentState.Active, active.State);
        // idle began at 300 seconds, not 360: those 60 seconds are excluded too (B04)
        Assert.Equal(Start.AddSeconds(300), active.EndedAt);
        Assert.Equal(300, active.DurationSec);
    }

    [Fact]
    public void Ten_minutes_away_excludes_exactly_ten_minutes()
    {
        var sm = New();
        var all = Run(sm, Start, 300, _ => TimeSpan.Zero).ToList();

        // nobody there for 10 minutes (ticks from 301 to 900 seconds)
        all.AddRange(Run(sm, Start.AddSeconds(300), 600, i => TimeSpan.FromSeconds(i)));
        // came back and moved the mouse exactly at the 900-second mark
        all.AddRange(sm.Tick(Start.AddSeconds(900), TimeSpan.Zero, locked: false, screenFrozen: false));

        // Careful: long segments are now split every 5 minutes too, so the **sum** is
        // checked, not the count. The rule is the same: 10 minutes away, exactly 10 minutes
        // excluded.
        var idleAll = all.Where(c => c.State == SegmentState.Idle).ToList();

        Assert.NotEmpty(idleAll);
        Assert.Equal(600, idleAll.Sum(c => c.DurationSec));
        Assert.All(idleAll, c => Assert.False(c.CountsAsWork));
    }

    [Fact]
    public void Input_resumes_counting_immediately()
    {
        var sm = New();
        Run(sm, Start, 300, _ => TimeSpan.Zero);
        Run(sm, Start.AddSeconds(300), 120, i => TimeSpan.FromSeconds(i));
        Assert.Equal(SegmentState.Idle, sm.State);

        // back within one tick: no waiting (B03)
        sm.Tick(Start.AddSeconds(421), TimeSpan.Zero, locked: false, screenFrozen: false);
        Assert.Equal(SegmentState.Active, sm.State);
    }

    [Fact]
    public void Locking_gives_LOCKED_and_input_after_unlock_gives_ACTIVE()
    {
        var sm = New();
        Run(sm, Start, 60, _ => TimeSpan.Zero);

        var closed = sm.Tick(Start.AddSeconds(61), TimeSpan.Zero, locked: true, screenFrozen: false);
        Assert.Single(closed);
        Assert.Equal(SegmentState.Locked, sm.State);

        // time is not counted while locked
        Run(sm, Start.AddSeconds(61), 300, _ => TimeSpan.Zero, locked: true);
        Assert.Equal(SegmentState.Locked, sm.State);

        closed = sm.Tick(Start.AddSeconds(362), TimeSpan.Zero, locked: false, screenFrozen: false);
        var locked = Assert.Single(closed);
        Assert.Equal(SegmentState.Locked, locked.State);
        Assert.False(locked.CountsAsWork);
        Assert.Equal(SegmentState.Active, sm.State);
    }

    [Fact]
    public void Unlocking_without_input_gives_IDLE_not_ACTIVE()
    {
        var sm = New();
        sm.Tick(Start.AddSeconds(1), TimeSpan.Zero, locked: true, screenFrozen: false);

        // unlocked, but the last input was long ago
        sm.Tick(Start.AddSeconds(400), TimeSpan.FromSeconds(300), locked: false, screenFrozen: false);

        Assert.Equal(SegmentState.Idle, sm.State);
    }

    [Fact]
    public void Waking_from_sleep_adds_no_phantom_time()
    {
        var sm = New();
        Run(sm, Start, 300, _ => TimeSpan.Zero);

        var suspendAt = Start.AddSeconds(300);
        var closed = sm.OnSuspend(suspendAt);
        var active = Assert.Single(closed);
        Assert.Equal(300, active.DurationSec);

        // 8 hours of sleep
        var resumeAt = suspendAt.AddHours(8);
        closed = sm.OnResume(resumeAt);

        // the sleep time closed as LOCKED, not as work
        Assert.All(closed, s => Assert.False(s.CountsAsWork));
        Assert.Equal(SegmentState.Idle, sm.State);
    }

    [Fact]
    public void Crossing_midnight_splits_the_segment_across_two_dates()
    {
        // 23:50 local (UTC+6 in tests) = 17:50Z
        var lateNight = new DateTimeOffset(2026, 8, 8, 17, 50, 0, TimeSpan.Zero);
        var sm = New(lateNight);

        // 20 minutes of continuous work, across midnight
        var closed = Run(sm, lateNight, 20 * 60, _ => TimeSpan.Zero);

        // Careful: long segments are split every 5 minutes too, so several pieces arrive.
        // What to verify: all pieces from **before** midnight are on the earlier date, and
        // their sum is exactly 10 minutes (23:50 → 00:00).
        var midnight = new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero);
        var before = closed.Where(c => c.EndedAt <= midnight).ToList();

        Assert.NotEmpty(before);
        Assert.All(before, c => Assert.Equal(new DateOnly(2026, 8, 8), c.WorkDate));
        Assert.Equal(600, before.Sum(c => c.DurationSec));
        Assert.Equal(midnight, before[^1].EndedAt);

        // The part after midnight: however many pieces, all on the new date,
        // and the sum is exactly 10 minutes (00:00 → 00:10)
        var after = closed.Where(c => c.StartedAt >= midnight).ToList();
        after.AddRange(sm.CloseAll(lateNight.AddMinutes(20)));

        Assert.NotEmpty(after);
        Assert.All(after, c => Assert.Equal(new DateOnly(2026, 8, 9), c.WorkDate));
        Assert.Equal(600, after.Sum(c => c.DurationSec));
    }

    [Fact]
    public void No_segment_spans_two_dates()
    {
        var lateNight = new DateTimeOffset(2026, 8, 8, 17, 0, 0, TimeSpan.Zero);
        var sm = New(lateNight);

        var closed = Run(sm, lateNight, 3 * 60 * 60, _ => TimeSpan.Zero);
        closed.AddRange(sm.CloseAll(lateNight.AddHours(3)));

        Assert.All(closed, s =>
            Assert.Equal(
                oXeio.Core.Time.WorkTime.WorkDateOf(s.StartedAt),
                oXeio.Core.Time.WorkTime.WorkDateOf(s.EndedAt.AddTicks(-1))));
    }

    [Fact]
    public void Only_ACTIVE_counts_as_work()
    {
        var sm = New();
        var closed = Run(sm, Start, 300, _ => TimeSpan.Zero);   // 0 → 300 working

        // 300 → 600 idle; this is where the first ACTIVE segment closes
        closed.AddRange(Run(sm, Start.AddSeconds(300), 300, i => TimeSpan.FromSeconds(i)));

        closed.AddRange(sm.Tick(Start.AddSeconds(600), TimeSpan.Zero, locked: false, screenFrozen: false));
        closed.AddRange(sm.CloseAll(Start.AddSeconds(700)));    // 600 → 700 working

        var worked = closed.Where(s => s.CountsAsWork).Sum(s => s.DurationSec);
        var notWorked = closed.Where(s => !s.CountsAsWork).Sum(s => s.DurationSec);

        Assert.Equal(400, worked);     // 300 + 100
        Assert.Equal(300, notWorked);  // exactly 5 minutes, counting the retro-adjust
    }

    [Fact]
    public void Input_score_stays_between_zero_and_one_hundred()
    {
        var sm = New();
        // input in half the seconds, none in the other half, but never exceeding the threshold
        Run(sm, Start, 300, i => i % 2 == 0 ? TimeSpan.Zero : TimeSpan.FromSeconds(5));
        var closed = sm.CloseAll(Start.AddSeconds(300));

        var seg = Assert.Single(closed);
        Assert.NotNull(seg.InputScore);
        Assert.InRange(seg.InputScore!.Value, 0, 100);
        Assert.Equal(50, seg.InputScore);
    }

    // ── G46 · fake input: counting stops while the screen is frozen ─────────

    /// <summary>
    /// <b>The whole purpose of this feature.</b>
    ///
    /// With a jiggler running, <c>sinceLastInput</c> is always near zero, so under the
    /// old rule it was ACTIVE forever. Once it is known that the screen is frozen, that
    /// is no longer trusted.
    /// </summary>
    [Fact]
    public void Frozen_screen_stops_counting_even_with_fresh_input()
    {
        var sm = new IdleStateMachine(Threshold, Start);

        // input is perfectly fresh, yet the screen is frozen
        sm.Tick(Start.AddSeconds(1), TimeSpan.Zero, locked: false, screenFrozen: true);

        Assert.Equal(SegmentState.Idle, sm.State);
    }

    /// <summary>Counting resumes immediately when the screen changes again; no waiting</summary>
    [Fact]
    public void Screen_moving_again_resumes_counting()
    {
        var sm = new IdleStateMachine(Threshold, Start);

        sm.Tick(Start.AddSeconds(1), TimeSpan.Zero, locked: false, screenFrozen: true);
        Assert.Equal(SegmentState.Idle, sm.State);

        sm.Tick(Start.AddSeconds(2), TimeSpan.Zero, locked: false, screenFrozen: false);

        Assert.Equal(SegmentState.Active, sm.State);
    }

    /// <summary>
    /// Careful: when it stops because of a frozen screen, <b>it does not cut backwards</b>.
    ///
    /// For real idle there is a retro-adjust (the threshold had already been idle), but
    /// not here: the screen was frozen for ten minutes, and cutting those ten minutes
    /// backwards would also remove <b>the time of an honest worker reading a long
    /// document</b>. If it errs, it errs in the worker's favor: the segment closes
    /// <b>now</b>, not earlier.
    /// </summary>
    [Fact]
    public void Frozen_screen_does_not_retro_adjust()
    {
        var sm = new IdleStateMachine(Threshold, Start);
        var at = Start.AddSeconds(120);

        var closed = sm.Tick(at, TimeSpan.Zero, locked: false, screenFrozen: true);

        var active = Assert.Single(closed);
        Assert.Equal(SegmentState.Active, active.State);
        Assert.Equal(at, active.EndedAt);
    }

    /// <summary>
    /// Careful: when locked the screen question does not arise; LOCKED comes first
    /// </summary>
    [Fact]
    public void Locked_wins_over_frozen()
    {
        var sm = new IdleStateMachine(Threshold, Start);

        sm.Tick(Start.AddSeconds(1), TimeSpan.Zero, locked: true, screenFrozen: true);

        Assert.Equal(SegmentState.Locked, sm.State);
    }
}
