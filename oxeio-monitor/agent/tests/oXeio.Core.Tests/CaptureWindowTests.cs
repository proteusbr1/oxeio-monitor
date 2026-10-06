using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

public class CaptureWindowTests
{
    /// <summary>Local time (tests run in UTC+6) to a UTC instant</summary>
    private static DateTimeOffset Local(int hour, int minute = 0) =>
        new DateTimeOffset(2026, 8, 9, hour, minute, 0, TimeSpan.Zero)
            .AddHours(-6);

    [Theory]
    [InlineData(6, 59, false)]
    [InlineData(7, 0, true)]   // start is inclusive
    [InlineData(12, 0, true)]
    [InlineData(22, 59, true)]
    [InlineData(23, 0, false)] // end is exclusive
    [InlineData(2, 0, false)]  // 2 AM: time is counted, pictures are not
    public void No_screenshots_outside_seven_to_twenty_three(int h, int m, bool allowed)
    {
        Assert.Equal(allowed, CaptureWindow.Default.Allows(Local(h, m)));
    }

    [Fact]
    public void With_no_window_screenshots_are_allowed_around_the_clock()
    {
        Assert.True(CaptureWindow.Always.Allows(Local(3)));
        Assert.True(CaptureWindow.Always.Allows(Local(23, 30)));
    }

    [Fact]
    public void A_window_crossing_midnight_works_too()
    {
        // 23:00 -> 07:00 (the limit in the opposite direction)
        var night = new CaptureWindow(new TimeOnly(23, 0), new TimeOnly(7, 0));

        Assert.True(night.Allows(Local(23, 30)));
        Assert.True(night.Allows(Local(2)));
        Assert.False(night.Allows(Local(12)));
    }
}
