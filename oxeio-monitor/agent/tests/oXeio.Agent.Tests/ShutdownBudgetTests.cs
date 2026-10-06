namespace oXeio.Agent.Tests;

/// <summary>
/// <b>R29-B / G136: the shutdown budgets must nest inside each other.</b>
///
/// Careful: this file exists for one reason. Until now these conditions were written
/// <b>only in comments</b> (<i>"must stay within Program.ShutdownBudget"</i>), and a
/// comment stops nobody. Raising one budget would fail silently: the drain would not
/// stop itself, Windows would kill the process <b>midway</b>, and the very
/// <c>agent_stop</c> that the whole wait is for would be lost. The compiler would not
/// catch it; it would show up in the field months later, as a stale agent_down wall
/// in the morning.
///
/// It tests the <b>relationships</b>, not the numbers: if someone changes 2.5 s to 3,
/// the test stays quiet as long as the ceilings are respected.
/// </summary>
public class ShutdownBudgetTests
{
    /// <summary>
    /// How long Windows gives an unresponsive app: the default of
    /// <c>WaitToKillAppTimeout</c> (5000 ms). Careful: it can be lowered in the
    /// registry, so this is a <b>ceiling</b>, not a promise; we stay far below it.
    /// </summary>
    private static readonly TimeSpan WindowsKillTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// On <c>WM_ENDSESSION</c> the UI thread is blocked, so this ceiling is the most
    /// sensitive one: above it the user would see "app is not responding".
    /// </summary>
    [Fact]
    public void শাটডাউনে_UI_থ্রেড_Windows_এর_সীমার_অর্ধেকের_কমই_আটকায়() =>
        Assert.True(
            AgentHost.EndSessionTotalBudget < WindowsKillTimeout / 2,
            $"EndSessionTotalBudget ({AgentHost.EndSessionTotalBudget}) " +
            $"Windows-এর {WindowsKillTimeout}-এর অর্ধেকের কম হতে হবে");

    /// <summary>
    /// Careful: the outer ceiling must equal the sum of the two inner steps. If it is
    /// smaller, the ceiling would <b>measure something other</b> than what it claims to,
    /// and if the write ran late there would be no time left to send.
    /// </summary>
    [Fact]
    public void বাইরের_ছাদ_ভেতরের_দুই_ধাপের_যোগফল() =>
        Assert.Equal(
            AgentHost.EndSessionEnqueueWait + AgentHost.EndSessionSendBudget,
            AgentHost.EndSessionTotalBudget);

    /// <summary>
    /// Careful: the write wait is inside the send ceiling; otherwise there would be no time to
    /// send.
    /// </summary>
    [Fact]
    public void কিউয়ে_লেখার_অপেক্ষা_পাঠানোর_ছাদের_ভেতরে() =>
        Assert.True(
            AgentHost.EndSessionEnqueueWait < AgentHost.EndSessionSendBudget,
            "EndSessionEnqueueWait must leave room for the send itself");

    /// <summary>
    /// Careful: the part of <c>DisposeAsync</c> that has <b>no budget</b>:
    /// <c>_stopping.CancelAsync()</c>, two <c>CloseAll</c> calls, four
    /// <c>Dispose()</c> calls, and the SQLite checkpoint of <c>_outbox.DisposeAsync()</c>.
    /// The number is not measured, it is <b>headroom</b>: so the budgeted steps do not
    /// <b>touch</b> the ceiling.
    /// </summary>
    private static readonly TimeSpan DisposeOverhead = TimeSpan.FromMilliseconds(400);

    /// <summary>
    /// The <b>three</b> steps of <c>DisposeAsync</c> together cannot exceed
    /// <c>Program.ShutdownBudget</c>.
    ///
    /// Careful: <b>this test used to be wrong</b> (G161). It added only the <b>two</b>
    /// drains (2 + 1.5 = 3.5 &lt;= 4, green), and the
    /// <see cref="AgentHost.StopEnqueueBudget"/> step that runs just before them was in
    /// no sum. A separate test measured it alone (<c>2 &lt; 4</c>, green). So the suite
    /// stayed green even though the real sum was <b>5.5 &gt; 4</b>.
    ///
    /// Careful: this is exactly the failure described in this file's own introduction,
    /// "the condition was in a comment, nothing guarded it", except this time the
    /// <b>guard itself</b> was incomplete. So there is now <b>one</b> test containing
    /// all three steps; if a fourth step is added later it belongs here too.
    /// </summary>
    [Fact]
    public void Dispose_এর_তিনটে_ধাপ_মিলে_শাটডাউন_বাজেটের_ভেতরে()
    {
        var sequential =
            AgentHost.StopEnqueueBudget + AgentHost.GoodbyeBudget + AgentHost.FinalDrainBudget;

        Assert.True(
            sequential + DisposeOverhead <= Program.ShutdownBudget,
            $"enqueue ({AgentHost.StopEnqueueBudget}) + goodbye ({AgentHost.GoodbyeBudget}) " +
            $"+ final ({AgentHost.FinalDrainBudget}) = {sequential}; " +
            $"বাজেটহীন কাজের জন্য {DisposeOverhead} রেখে " +
            $"ShutdownBudget ({Program.ShutdownBudget})-এর ভেতরে থাকতে হবে");
    }

    /// <summary>Careful: the whole DisposeAsync is also below Windows' limit.</summary>
    [Fact]
    public void শাটডাউন_বাজেট_Windows_এর_সীমার_নিচে() =>
        Assert.True(Program.ShutdownBudget < WindowsKillTimeout);

    /// <summary>
    /// Both shutdown paths take the same budget for the same job (G161).
    ///
    /// Careful: the <c>WM_ENDSESSION</c> path and the <c>DisposeAsync</c> path both wait
    /// for one SQLite INSERT and then send one small POST. With two different numbers,
    /// one day one path would be fixed and the other left stale; that is exactly what
    /// keeps happening in this project.
    /// </summary>
    [Fact]
    public void দুই_শাটডাউন_পথ_একই_কাজে_একই_বাজেট_নেয়()
    {
        Assert.Equal(AgentHost.EndSessionEnqueueWait, AgentHost.StopEnqueueBudget);
        Assert.Equal(AgentHost.EndSessionSendBudget, AgentHost.GoodbyeBudget);
    }
}
