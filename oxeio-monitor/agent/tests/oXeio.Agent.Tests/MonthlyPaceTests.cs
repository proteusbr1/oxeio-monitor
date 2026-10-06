using oXeio.Agent.Ui;

namespace oXeio.Agent.Tests;

/// <summary>
/// J04's "ahead or behind": the number is the server's; these tests pin which statement is
/// written, and in what order the decision is made.
/// </summary>
public class MonthlyPaceTests
{
    /// <summary>
    /// G111: "not observed yet" is not "exactly on target".
    ///
    /// Careful: in this state the server sends <c>paceSec: 0</c>, so "0:00 ahead" would
    /// be shown: praise on a new staff member's first day with not one observation behind it.
    /// </summary>
    [Fact]
    public void Not_observed_wins_even_over_a_server_zero()
    {
        Assert.Equal(MonthlyPace.PaceView.NotObserved, MonthlyPace.ViewFor(false, TimeSpan.Zero));
    }

    [Fact]
    public void When_observed_the_server_number_is_used()
    {
        Assert.Equal(MonthlyPace.PaceView.Server, MonthlyPace.ViewFor(true, TimeSpan.FromHours(-2)));
    }

    /// <summary>No number (no target, or an old server): the line is dropped, not guessed.</summary>
    [Fact]
    public void With_no_number_at_all_the_line_is_dropped()
    {
        Assert.Equal(MonthlyPace.PaceView.None, MonthlyPace.ViewFor(true, null));
    }
}
