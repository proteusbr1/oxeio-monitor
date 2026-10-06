using oXeio.Core.Tracking;

namespace oXeio.Core.Tests;

/// <summary>
/// This subtraction is the basis of the hour count; a mistake here can wipe out someone's whole
/// day of work.
/// </summary>
public class IdleMathTests
{
    [Fact]
    public void In_the_normal_case_the_difference_is_the_result()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(75),
            IdleMath.Elapsed(nowTicks32: 100_000, lastInputTicks32: 25_000));
    }

    [Fact]
    public void Input_just_now_gives_zero()
    {
        Assert.Equal(TimeSpan.Zero, IdleMath.Elapsed(500_000, 500_000));
    }

    /// <summary>
    /// GetTickCount wraps around after 49.7 days. Modular subtraction gives the right
    /// answer by itself; no separate condition is needed.
    /// </summary>
    [Fact]
    public void The_result_is_correct_across_a_tick_counter_wrap()
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
    public void A_future_timestamp_is_clamped_to_zero()
    {
        uint now = 1_000_000;
        uint lastInput = now + 5_000; // 5 seconds ahead

        var elapsed = IdleMath.Elapsed(now, lastInput, out var clamped);

        Assert.True(clamped);
        Assert.Equal(TimeSpan.Zero, elapsed);
    }

    [Fact]
    public void Without_the_clamp_the_error_would_be_huge()
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
    public void No_input_ever_gives_a_negative_time(uint lastInput)
    {
        var elapsed = IdleMath.Elapsed(12_345, lastInput);
        Assert.True(elapsed >= TimeSpan.Zero);
    }
}
