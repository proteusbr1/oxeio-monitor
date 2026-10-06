using oXeio.Core.Models;
using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// Even during continuous work, segments must close regularly and go to the queue;
/// otherwise a power cut would lose that whole stretch.
/// </summary>
public class SegmentDurabilityTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 10, 10, 0, 0, TimeSpan.FromHours(6));

    private static readonly TimeSpan Threshold = TimeSpan.FromSeconds(60);

    /// <summary>A tick every second, input always arriving (continuous work).</summary>
    private static List<ActivitySegment> RunBusy(IdleStateMachine m, TimeSpan span)
    {
        var all = new List<ActivitySegment>();
        for (var s = 1; s <= (int)span.TotalSeconds; s++)
            all.AddRange(m.Tick(T0.AddSeconds(s), TimeSpan.Zero, locked: false, screenFrozen: false));
        return all;
    }

    [Fact]
    public void টানা_কাজেও_সেগমেন্ট_নিয়মিত_বন্ধ_হয়()
    {
        var m = new IdleStateMachine(Threshold, T0);

        var closed = RunBusy(m, TimeSpan.FromMinutes(17));

        // split every 5 minutes: 3 full segments in 17 minutes
        Assert.Equal(3, closed.Count);
        Assert.All(closed, s => Assert.Equal(SegmentState.Active, s.State));
        Assert.All(closed, s => Assert.Equal(300, s.DurationSec));
    }

    [Fact]
    public void ভাগ_হলেও_কোনো_সেকেন্ড_হারায়_না_বা_দুবার_গোনা_হয়_না()
    {
        var m = new IdleStateMachine(Threshold, T0);

        var closed = RunBusy(m, TimeSpan.FromMinutes(17));
        closed.AddRange(m.CloseAll(T0.AddMinutes(17)));

        Assert.Equal(17 * 60, closed.Sum(s => s.DurationSec));

        // in order, no gaps, no overlaps
        for (var i = 1; i < closed.Count; i++)
            Assert.Equal(closed[i - 1].EndedAt, closed[i].StartedAt);
    }

    [Fact]
    public void প্রতিটি_ভাগের_আলাদা_uuid_থাকে()
    {
        // With the same uuid the server would take the second as a duplicate and drop
        // it, so time would still be lost even after splitting
        var m = new IdleStateMachine(Threshold, T0);

        var closed = RunBusy(m, TimeSpan.FromMinutes(17));

        Assert.Equal(closed.Count, closed.Select(s => s.ClientUuid).Distinct().Count());
    }

    [Fact]
    public void স্টেট_বদলালে_ভাগের_ঘড়ি_নতুন_করে_শুরু_হয়()
    {
        var m = new IdleStateMachine(Threshold, T0);

        // 4 minutes of work, then going idle
        RunBusy(m, TimeSpan.FromMinutes(4));
        var closed = m.Tick(T0.AddMinutes(5), TimeSpan.FromSeconds(61), locked: false, screenFrozen: false);

        Assert.Single(closed);
        Assert.Equal(SegmentState.Active, closed[0].State);
    }

    [Fact]
    public void নিষ্ক্রিয়_সময়ও_ভাগ_হয়()
    {
        // When someone goes to lunch an IDLE segment would stay open for an hour. That
        // is not work time, but if a crash lost it, it would later be unclear what that time was.
        var m = new IdleStateMachine(Threshold, T0);
        var all = new List<ActivitySegment>();

        for (var s = 1; s <= 20 * 60; s++)
            all.AddRange(m.Tick(T0.AddSeconds(s), TimeSpan.FromMinutes(30), locked: false, screenFrozen: false));

        Assert.Contains(all, s => s.State == SegmentState.Idle);
        Assert.All(all.Where(s => s.State == SegmentState.Idle),
            s => Assert.True(s.DurationSec <= 300));
    }

    [Fact]
    public void মাপটা_বদলানো_যায়_কিন্তু_শূন্য_দেওয়া_যায়_না()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new IdleStateMachine(Threshold, T0, maxSegment: TimeSpan.Zero));
    }

    /// <summary>
    /// The most important test: after splitting, retro-adjust (B04) must stay intact.
    ///
    /// If the last 60 seconds had already left as a separate segment, it could no longer
    /// be cut backwards, and the idle time would silently be **counted as work**.
    /// </summary>
    [Fact]
    public void ভাগ_করার_পরেও_retro_adjust_পুরো_ষাট_সেকেন্ড_কাটে()
    {
        var m = new IdleStateMachine(Threshold, T0);
        var all = new List<ActivitySegment>();

        // work a little past the exact split boundary, then hands off
        for (var s = 1; s <= 7 * 60; s++)
            all.AddRange(m.Tick(T0.AddSeconds(s), TimeSpan.Zero, locked: false, screenFrozen: false));

        // now 60 seconds idle
        for (var s = 7 * 60 + 1; s <= 8 * 60; s++)
        {
            var idleFor = TimeSpan.FromSeconds(s - 7 * 60);
            all.AddRange(m.Tick(T0.AddSeconds(s), idleFor, locked: false, screenFrozen: false));
        }

        all.AddRange(m.CloseAll(T0.AddSeconds(8 * 60)));

        var worked = all.Where(x => x.CountsAsWork).Sum(x => x.DurationSec);

        // The last 60 seconds of the 8 minutes were idle, and retro-adjust removes
        // exactly that much: not a second more or less (B04).
        // The sum must stay the same after splitting too.
        Assert.Equal(7 * 60, worked);
    }

    [Fact]
    public void ডিফল্ট_মাপ_পাঁচ_মিনিট()
    {
        Assert.Equal(TimeSpan.FromMinutes(5), IdleStateMachine.MaxSegmentLength);
    }
}
