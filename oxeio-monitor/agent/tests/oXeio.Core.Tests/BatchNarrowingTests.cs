using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class BatchNarrowingTests
{
    [Fact]
    public void It_starts_at_the_full_size()
    {
        Assert.Equal(500, new BatchNarrowing(500).Current);
    }

    [Fact]
    public void A_transient_failure_does_not_change_the_size()
    {
        // When the network is down the batch is not at fault; shrinking it would make
        // the drain needlessly slow after the link returns
        var n = new BatchNarrowing(500);

        n.OnTransient();
        n.OnTransient();

        Assert.Equal(500, n.Current);
    }

    [Fact]
    public void A_permanent_failure_halves_the_batch()
    {
        var n = new BatchNarrowing(500);

        n.OnPermanent();
        Assert.Equal(250, n.Current);

        n.OnPermanent();
        Assert.Equal(125, n.Current);
    }

    [Fact]
    public void Repeated_halving_ends_at_a_single_record()
    {
        var n = new BatchNarrowing(500);
        var steps = 0;

        while (!n.IsIsolated)
        {
            n.OnPermanent();
            steps++;
            Assert.True(steps < 20, "stuck somewhere — it is not halving");
        }

        Assert.Equal(1, n.Current);

        // 500 -> 250 -> 125 -> 62 -> 31 -> 15 -> 7 -> 3 -> 1: 8 steps in total.
        // The number is written here so that a change to the halving rule is caught by the test.
        Assert.Equal(8, steps);
    }

    [Fact]
    public void Once_at_one_record_it_gets_no_smaller()
    {
        var n = new BatchNarrowing(1);

        n.OnPermanent();

        Assert.Equal(1, n.Current);
        Assert.True(n.IsIsolated);
    }

    [Fact]
    public void A_success_returns_to_the_full_size()
    {
        var n = new BatchNarrowing(500);
        n.OnPermanent();
        n.OnPermanent();

        n.OnSuccess();

        Assert.Equal(500, n.Current);
    }

    /// <summary>
    /// Without this, after one bad record everything would be sent one at a time for
    /// the rest of time. A backlog of 50,000 rows would then be stuck at the limit of
    /// 55 per minute and take over 15 hours.
    /// </summary>
    [Fact]
    public void After_dropping_the_bad_record_it_returns_to_the_full_size()
    {
        var n = new BatchNarrowing(500);
        while (!n.IsIsolated) n.OnPermanent();

        n.OnIsolatedDropped();

        Assert.Equal(500, n.Current);
        Assert.False(n.IsIsolated);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(-5, 1)]
    [InlineData(1000, 500)] // cannot ask for more than the server's limit
    public void An_impossible_size_is_clamped_into_range(int given, int expected)
    {
        Assert.Equal(expected, new BatchNarrowing(given).Current);
    }
}
