using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class BatchNarrowingTests
{
    [Fact]
    public void শুরুতে_পুরো_মাপেই_চেষ্টা_হয়()
    {
        Assert.Equal(500, new BatchNarrowing(500).Current);
    }

    [Fact]
    public void সাময়িক_ব্যর্থতায়_মাপ_বদলায়_না()
    {
        // When the network is down the batch is not at fault; shrinking it would make
        // the drain needlessly slow after the link returns
        var n = new BatchNarrowing(500);

        n.OnTransient();
        n.OnTransient();

        Assert.Equal(500, n.Current);
    }

    [Fact]
    public void Permanent_পেলে_ব্যাচ_অর্ধেক_হয়()
    {
        var n = new BatchNarrowing(500);

        n.OnPermanent();
        Assert.Equal(250, n.Current);

        n.OnPermanent();
        Assert.Equal(125, n.Current);
    }

    [Fact]
    public void বারবার_অর্ধেক_হয়ে_শেষে_একটায়_নামে()
    {
        var n = new BatchNarrowing(500);
        var steps = 0;

        while (!n.IsIsolated)
        {
            n.OnPermanent();
            steps++;
            Assert.True(steps < 20, "কোথাও আটকে গেছে — অর্ধেক হচ্ছে না");
        }

        Assert.Equal(1, n.Current);

        // 500 -> 250 -> 125 -> 62 -> 31 -> 15 -> 7 -> 3 -> 1: 8 steps in total.
        // The number is written here so that a change to the halving rule is caught by the test.
        Assert.Equal(8, steps);
    }

    [Fact]
    public void একটায়_নামার_পর_আর_ছোট_হয়_না()
    {
        var n = new BatchNarrowing(1);

        n.OnPermanent();

        Assert.Equal(1, n.Current);
        Assert.True(n.IsIsolated);
    }

    [Fact]
    public void সফল_হলে_পুরো_মাপে_ফেরে()
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
    public void খারাপ_রেকর্ড_ফেলার_পর_পুরো_মাপে_ফেরে()
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
    public void অসম্ভব_মাপ_সীমার_মধ্যে_আটকায়(int given, int expected)
    {
        Assert.Equal(expected, new BatchNarrowing(given).Current);
    }
}
