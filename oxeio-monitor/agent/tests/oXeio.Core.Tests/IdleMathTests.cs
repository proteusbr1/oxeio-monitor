using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// This subtraction is the basis of the hour count; a mistake here can wipe out someone's whole
/// day of work.
/// </summary>
public class IdleMathTests
{
    [Fact]
    public void সাধারণ_ক্ষেত্রে_পার্থক্যই_ফল()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(75),
            IdleMath.Elapsed(nowTicks32: 100_000, lastInputTicks32: 25_000));
    }

    [Fact]
    public void এইমাত্র_ইনপুট_হলে_শূন্য()
    {
        Assert.Equal(TimeSpan.Zero, IdleMath.Elapsed(500_000, 500_000));
    }

    /// <summary>
    /// GetTickCount wraps around after 49.7 days. Modular subtraction gives the right
    /// answer by itself; no separate condition is needed.
    /// </summary>
    [Fact]
    public void ঘড়ি_উল্টে_গেলেও_হিসাব_ঠিক_থাকে()
    {
        // the last input was 5 seconds before the wrap, now is 3 seconds after it
        uint lastInput = uint.MaxValue - 5_000 + 1;
        uint now = 3_000;

        var elapsed = IdleMath.Elapsed(now, lastInput, out var clamped);

        Assert.Equal(TimeSpan.FromSeconds(8), elapsed);
        Assert.False(clamped);
    }

    /// <summary>
    /// Microsoft says dwTime is "not guaranteed to be incremental". With the input just
    /// 5 seconds ahead, plain subtraction would give 49.7 days, and that staff member
    /// would show "inactive" all day.
    /// </summary>
    [Fact]
    public void ভবিষ্যতের_টাইমস্ট্যাম্প_শূন্যে_আটকে_যায়()
    {
        uint now = 1_000_000;
        uint lastInput = now + 5_000; // 5 seconds ahead

        var elapsed = IdleMath.Elapsed(now, lastInput, out var clamped);

        Assert.True(clamped);
        Assert.Equal(TimeSpan.Zero, elapsed);
    }

    [Fact]
    public void ক্ল্যাম্প_না_থাকলে_কত_বড়_ভুল_হতো()
    {
        uint now = 1_000_000;
        uint lastInput = now + 5_000;

        // Showing what the raw result would be without the clamp, so nobody deletes
        // this condition one day thinking "this check is unnecessary"
        var raw = unchecked(now - lastInput);
        Assert.True(TimeSpan.FromMilliseconds(raw).TotalDays > 49);
    }

    [Theory]
    [InlineData(0u)]
    [InlineData(1u)]
    [InlineData(uint.MaxValue)]
    [InlineData(IdleMath.FutureGuard)]
    public void কোনো_ইনপুটেই_ঋণাত্মক_সময়_আসে_না(uint lastInput)
    {
        var elapsed = IdleMath.Elapsed(12_345, lastInput);
        Assert.True(elapsed >= TimeSpan.Zero);
    }
}
