using oXeio.Core.Time;

namespace oXeio.Core.Tests;

/// <summary>
/// Must give exactly the same result as the server's <c>dhaka-time.ts</c>;
/// otherwise the agent and the server would compute different <c>work_date</c> values.
/// </summary>
public class DhakaTimeTests
{
    [Fact]
    public void রাত_এগারোটা_পঞ্চাশ_আগের_দিনেই_পড়ে()
    {
        var t = new DateTimeOffset(2026, 8, 8, 17, 50, 0, TimeSpan.Zero); // 23:50 in Dhaka
        Assert.Equal(new DateOnly(2026, 8, 8), DhakaTime.WorkDateOf(t));
    }

    [Fact]
    public void মধ্যরাতের_পর_নতুন_দিন()
    {
        var t = new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero); // 00:00 in Dhaka
        Assert.Equal(new DateOnly(2026, 8, 9), DhakaTime.WorkDateOf(t));
    }

    [Fact]
    public void পরের_মধ্যরাত_ঠিক_জায়গায়()
    {
        var t = new DateTimeOffset(2026, 8, 8, 17, 50, 0, TimeSpan.Zero);
        Assert.Equal(
            new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero),
            DhakaTime.NextLocalMidnight(t));
    }

    [Fact]
    public void ঠিক_মধ্যরাতে_দাঁড়ালে_পরেরটা_চব্বিশ_ঘণ্টা_পরে()
    {
        var midnight = new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero);
        Assert.Equal(midnight.AddDays(1), DhakaTime.NextLocalMidnight(midnight));
    }

    [Fact]
    public void স্থানীয়_ঘড়ির_সময়_ঠিক_আসে()
    {
        var t = new DateTimeOffset(2026, 8, 9, 1, 0, 0, TimeSpan.Zero); // 07:00 in Dhaka
        Assert.Equal(new TimeOnly(7, 0), DhakaTime.LocalTimeOf(t));
    }
}
