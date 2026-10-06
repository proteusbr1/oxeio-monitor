using oXeio.Core.Capture;

namespace oXeio.Core.Tests;

public class EngineFallbackPolicyTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 10, 10, 0, 0, TimeSpan.FromHours(6));

    private static EngineFallbackPolicy Policy(int failures = 3, int cooldownMin = 30)
        => new(failures, TimeSpan.FromMinutes(cooldownMin));

    [Fact]
    public void The_primary_engine_is_tried_first()
    {
        Assert.True(Policy().ShouldTryPrimary(T0));
    }

    [Fact]
    public void Fewer_failures_than_the_limit_do_not_pause_it()
    {
        var p = Policy(failures: 3);

        p.RecordFailure(T0);
        p.RecordFailure(T0);

        // One or two failures prove nothing; it can happen on the lock screen alone
        Assert.True(p.ShouldTryPrimary(T0));
    }

    [Fact]
    public void Consecutive_failures_start_a_cooldown()
    {
        var p = Policy(failures: 3, cooldownMin: 30);

        p.RecordFailure(T0);
        p.RecordFailure(T0);
        p.RecordFailure(T0);

        Assert.False(p.ShouldTryPrimary(T0));
        Assert.Equal(T0.AddMinutes(30), p.RestingUntil);
    }

    [Fact]
    public void The_primary_is_tried_again_when_the_cooldown_ends()
    {
        var p = Policy(failures: 3, cooldownMin: 30);
        for (var i = 0; i < 3; i++) p.RecordFailure(T0);

        Assert.False(p.ShouldTryPrimary(T0.AddMinutes(29)));
        Assert.True(p.ShouldTryPrimary(T0.AddMinutes(30)));
    }

    /// <summary>
    /// This is the bug that would slip in most easily: if the counter is not reset
    /// after a pause, the very next single failure would hit the limit again, so the
    /// pause would effectively become permanent and DXGI would never come back.
    /// </summary>
    [Fact]
    public void The_counter_restarts_from_zero_after_a_cooldown()
    {
        var p = Policy(failures: 3, cooldownMin: 30);
        for (var i = 0; i < 3; i++) p.RecordFailure(T0);

        var after = T0.AddMinutes(31);
        Assert.True(p.ShouldTryPrimary(after));
        Assert.Equal(0, p.ConsecutiveFailures);

        p.RecordFailure(after);
        Assert.True(p.ShouldTryPrimary(after)); // one failure does not pause it again
    }

    [Fact]
    public void A_success_clears_the_failure_count()
    {
        var p = Policy(failures: 3);

        p.RecordFailure(T0);
        p.RecordFailure(T0);
        p.RecordSuccess();

        Assert.Equal(0, p.ConsecutiveFailures);

        p.RecordFailure(T0);
        p.RecordFailure(T0);
        Assert.True(p.ShouldTryPrimary(T0)); // the earlier two are no longer counted
    }

    [Fact]
    public void A_failure_during_the_cooldown_does_not_extend_it()
    {
        // While the fallback engine runs the primary is not called at all, so
        // RecordFailure should not arrive. If it does, the pause deadline must not be
        // pushed back; otherwise on a busy machine the pause would never end.
        var p = Policy(failures: 3, cooldownMin: 30);
        for (var i = 0; i < 3; i++) p.RecordFailure(T0);

        var until = p.RestingUntil;
        p.RecordFailure(T0.AddMinutes(10));

        Assert.Equal(until, p.RestingUntil);
    }

    [Fact]
    public void Default_values_are_as_specified()
    {
        Assert.Equal(3, EngineFallbackPolicy.DefaultFailuresBeforeCooldown);
        Assert.Equal(TimeSpan.FromMinutes(30), EngineFallbackPolicy.DefaultCooldown);
    }
}
