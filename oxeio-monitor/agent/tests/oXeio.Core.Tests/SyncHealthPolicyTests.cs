using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class SyncHealthPolicyTests
{
    private static readonly DateTimeOffset Start =
        new(2026, 8, 10, 9, 0, 0, TimeSpan.FromHours(6));

    private static readonly SyncHealthPolicy P = SyncHealthPolicy.Default;

    [Fact]
    public void An_empty_queue_is_always_healthy()
    {
        // At 3 AM there is nothing to send, so showing red makes no sense
        var h = P.Evaluate(
            lastSuccessAt: Start,
            startedAt: Start,
            queueDepth: 0,
            revoked: false,
            now: Start.AddDays(3));

        Assert.Equal(SyncHealth.Ok, h);
    }

    [Fact]
    public void A_recent_sync_is_healthy()
    {
        var h = P.Evaluate(Start.AddMinutes(10), Start, 40, false, Start.AddMinutes(12));

        Assert.Equal(SyncHealth.Ok, h);
    }

    [Fact]
    public void Stuck_for_fifteen_minutes_is_degraded()
    {
        var h = P.Evaluate(Start, Start, 40, false, Start.AddMinutes(15));

        Assert.Equal(SyncHealth.Degraded, h);
    }

    [Fact]
    public void Stuck_for_two_hours_is_failing()
    {
        var h = P.Evaluate(Start, Start, 40, false, Start.AddHours(2));

        Assert.Equal(SyncHealth.Failing, h);
    }

    /// <summary>
    /// A freshly installed agent has not succeeded even once yet. If it were not counted
    /// from the start time it would show red from the first minute, and staff's very
    /// first experience would be "something is broken".
    /// </summary>
    [Fact]
    public void Without_any_success_the_clock_runs_from_the_start_time()
    {
        Assert.Equal(
            SyncHealth.Ok,
            P.Evaluate(null, Start, 5, false, Start.AddMinutes(5)));

        Assert.Equal(
            SyncHealth.Failing,
            P.Evaluate(null, Start, 5, false, Start.AddHours(3)));
    }

    [Fact]
    public void Revoked_wins_over_everything_else()
    {
        // queue empty, synced just now; revoked still wins
        var h = P.Evaluate(Start, Start, 0, revoked: true, now: Start);

        Assert.Equal(SyncHealth.Revoked, h);
    }

    [Fact]
    public void The_J07_sentence_is_present_verbatim()
    {
        var text = SyncHealthPolicy.Describe(SyncHealth.Failing, 42);

        Assert.NotNull(text);
        Assert.Contains("Can't reach server, data saved locally", text);
        Assert.Contains("42", text);
    }

    [Fact]
    public void No_message_when_healthy()
    {
        Assert.Null(SyncHealthPolicy.Describe(SyncHealth.Ok, 0));
    }

    [Fact]
    public void Default_time_limits_are_as_specified()
    {
        Assert.Equal(TimeSpan.FromMinutes(15), SyncHealthPolicy.DefaultDegradedAfter);
        Assert.Equal(TimeSpan.FromHours(2), SyncHealthPolicy.DefaultFailingAfter);
    }
}
