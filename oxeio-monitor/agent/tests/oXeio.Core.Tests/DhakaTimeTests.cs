using oXeio.Core.Time;

namespace oXeio.Core.Tests;

/// <summary>
/// Must give exactly the same result as the server's <c>dhaka-time.ts</c>;
/// otherwise the agent and the server would compute different <c>work_date</c> values.
/// </summary>
public class DhakaTimeTests
{
    [Fact]
    public void Ten_to_midnight_falls_on_the_earlier_day()
    {
        var t = new DateTimeOffset(2026, 8, 8, 17, 50, 0, TimeSpan.Zero); // 23:50 in Dhaka
        Assert.Equal(new DateOnly(2026, 8, 8), DhakaTime.WorkDateOf(t));
    }

    [Fact]
    public void After_midnight_it_is_a_new_day()
    {
        var t = new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero); // 00:00 in Dhaka
        Assert.Equal(new DateOnly(2026, 8, 9), DhakaTime.WorkDateOf(t));
    }

    [Fact]
    public void The_next_midnight_is_computed_correctly()
    {
        var t = new DateTimeOffset(2026, 8, 8, 17, 50, 0, TimeSpan.Zero);
        Assert.Equal(
            new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero),
            DhakaTime.NextLocalMidnight(t));
    }

    [Fact]
    public void At_exactly_midnight_the_next_one_is_twenty_four_hours_later()
    {
        var midnight = new DateTimeOffset(2026, 8, 8, 18, 0, 0, TimeSpan.Zero);
        Assert.Equal(midnight.AddDays(1), DhakaTime.NextLocalMidnight(midnight));
    }

    [Fact]
    public void The_local_clock_time_is_correct()
    {
        var t = new DateTimeOffset(2026, 8, 9, 1, 0, 0, TimeSpan.Zero); // 07:00 in Dhaka
        Assert.Equal(new TimeOnly(7, 0), DhakaTime.LocalTimeOf(t));
    }
}
