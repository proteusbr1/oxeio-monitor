using System.Collections.Concurrent;

using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// <b>Several threads at once</b> (G160).
///
/// Careful: <b>the bug this file guards against:</b> <c>AgentHost</c> said
/// "<c>_machine</c> belongs to this loop", but <b>three</b> threads changed it: the
/// tracker (<c>Tick</c>), the WinForms message pump
/// (<c>OnPower -> OnSuspend/OnResume</c>), and the thread pool
/// (<c>DisposeAsync -> CloseAll</c>). There was no lock anywhere.
///
/// Careful: if two enter <c>EmitAndReopen</c> together, both read the same
/// <c>_openedAt</c> and build segments for <b>the same time span</b> with two different
/// <c>ClientUuid</c> values. The server dedupes only by <c>client_uuid</c> and does not
/// look at overlap, so <b>that time is counted twice, and paid twice</b>.
///
/// <b>How the test catches it:</b> the segments should sit on the timeline <b>like
/// tiles</b>: one ends, the next starts, never overlapping. Removing the lock breaks
/// exactly this rule.
///
/// Careful: <b>this is a probabilistic test, not a guarantee</b>, so the hammering is
/// deliberately heavy (<see cref="Rounds"/>), and both threads take time from the same
/// clock so that they really do enter at the same moment. With the lock removed it goes red.
/// </summary>
public class IdleStateMachineRaceTests
{
    private static readonly TimeSpan Threshold = TimeSpan.FromSeconds(60);
    private static readonly DateTimeOffset Start =
        new(2026, 9, 6, 4, 0, 0, TimeSpan.Zero); // 10 AM in Dhaka

    /// <summary>
    /// Careful: a race is not caught with few rounds. The critical section is a
    /// fraction of a microsecond, so creating a chance of collision takes many runs.
    /// </summary>
    private const int Rounds = 60_000;

    /// <summary>
    /// Both threads take time from the same clock. Careful: with separate clocks one
    /// would always be ahead of the other and the clamp would hide everything, so the
    /// race would go uncaught in the test and stay in the field.
    /// </summary>
    private sealed class SharedClock
    {
        private long _ticks;
        public DateTimeOffset Next() => Start.AddMilliseconds(Interlocked.Increment(ref _ticks) * 10);
    }

    /// <summary>
    /// <b>The main rule:</b> segments sit like tiles, none rising on top of another.
    /// </summary>
    private static void AssertNoOverlap(IEnumerable<ActivitySegment> segments)
    {
        var sorted = segments.OrderBy(s => s.StartedAt).ThenBy(s => s.EndedAt).ToList();

        for (var i = 0; i < sorted.Count; i++)
        {
            Assert.True(
                sorted[i].EndedAt >= sorted[i].StartedAt,
                $"সেগমেন্ট #{i} উল্টো: {sorted[i].StartedAt:O} → {sorted[i].EndedAt:O}");

            if (i == 0) continue;

            Assert.True(
                sorted[i].StartedAt >= sorted[i - 1].EndedAt,
                $"ওভারল্যাপ #{i}: আগেরটা শেষ {sorted[i - 1].EndedAt:O}, " +
                $"এটা শুরু {sorted[i].StartedAt:O} — ওই সময়টা দুবার গোনা হতো");
        }
    }

    /// <summary>
    /// <b>The main test of this file:</b> the tracker is ticking, and exactly then the
    /// message pump reports the screen sleeping/waking.
    ///
    /// Careful: this is the most familiar moment in the field: the office idle timeout
    /// turns the monitor off, Windows sends <c>PBT_POWERSETTINGCHANGE</c>, and that calls
    /// <c>OnSuspend</c> directly on the UI thread while the tracker is still inside its tick.
    /// </summary>
    [Fact]
    public void Time_is_not_counted_twice_when_tracker_and_power_events_enter_together()
    {
        var clock = new SharedClock();
        var sm = new IdleStateMachine(Threshold, Start);
        var all = new ConcurrentBag<ActivitySegment>();

        var tracker = new Thread(() =>
        {
            for (var i = 0; i < Rounds; i++)
            {
                // Careful: input alternates between present and absent; otherwise the
                // state would not change and `EmitAndReopen` would never be called.
                var sinceInput = i % 2 == 0 ? TimeSpan.Zero : Threshold + TimeSpan.FromSeconds(1);

                foreach (var s in sm.Tick(clock.Next(), sinceInput, locked: false, screenFrozen: false))
                    all.Add(s);
            }
        });

        var pump = new Thread(() =>
        {
            for (var i = 0; i < Rounds; i++)
            {
                foreach (var s in sm.OnSuspend(clock.Next())) all.Add(s);
                foreach (var s in sm.OnResume(clock.Next())) all.Add(s);
            }
        });

        tracker.Start();
        pump.Start();
        Assert.True(tracker.Join(TimeSpan.FromMinutes(2)), "ট্র্যাকার থ্রেড আটকে গেছে");
        Assert.True(pump.Join(TimeSpan.FromMinutes(2)), "পাম্প থ্রেড আটকে গেছে");

        Assert.NotEmpty(all);
        AssertNoOverlap(all);
    }

    /// <summary>
    /// Careful: <c>DisposeAsync</c> calls <c>CloseAll</c> from the thread pool exactly
    /// while the tracker is mid-tick. Cancelling <c>_stopping</c> does not mean the
    /// tracker has stopped; it checks the token only at the top of its loop.
    /// </summary>
    [Fact]
    public void The_final_segment_at_shutdown_does_not_overlap_either()
    {
        var clock = new SharedClock();
        var sm = new IdleStateMachine(Threshold, Start);
        var all = new ConcurrentBag<ActivitySegment>();

        var tracker = new Thread(() =>
        {
            for (var i = 0; i < Rounds; i++)
                foreach (var s in sm.Tick(clock.Next(), TimeSpan.Zero, locked: i % 3 == 0, screenFrozen: false))
                    all.Add(s);
        });

        var closer = new Thread(() =>
        {
            for (var i = 0; i < Rounds; i++)
                foreach (var s in sm.CloseAll(clock.Next())) all.Add(s);
        });

        tracker.Start();
        closer.Start();
        Assert.True(tracker.Join(TimeSpan.FromMinutes(2)), "ট্র্যাকার থ্রেড আটকে গেছে");
        Assert.True(closer.Join(TimeSpan.FromMinutes(2)), "বন্ধ করার থ্রেড আটকে গেছে");

        Assert.NotEmpty(all);
        AssertNoOverlap(all);
    }

    /// <summary>
    /// <b>Even if the clock goes back, <c>CloseAll</c> cannot move time backwards</b>
    /// (G160). Before, <c>_openedAt = at</c> was unconditional: given an earlier time, no
    /// segment came out (length zero), yet <c>_openedAt</c> moved <b>backwards</b>, and
    /// the next segment would fall inside the previous one.
    ///
    /// This is a <b>certain</b> test, not a probabilistic one: even with the lock intact,
    /// restoring this one line turns it red.
    /// </summary>
    [Fact]
    public void CloseAll_does_not_move_time_backwards_when_the_clock_goes_back()
    {
        var sm = new IdleStateMachine(Threshold, Start);

        var first = sm.CloseAll(Start.AddMinutes(10));
        Assert.Single(first);

        // Careful: the clock goes back 5 minutes (an NTP correction, or drift being fixed)
        Assert.Empty(sm.CloseAll(Start.AddMinutes(5)));

        var third = sm.CloseAll(Start.AddMinutes(12));

        Assert.Single(third);
        Assert.Equal(Start.AddMinutes(10), third[0].StartedAt);
        AssertNoOverlap(first.Concat(third));
    }
}
