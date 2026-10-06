using oXeio.Agent.Ui;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Tests;

/// <summary>
/// The tooltip's <b>priority order</b>.
///
/// Careful: what is really being tested here is not the text but the <b>order</b>:
/// which message gets a place within the 63 characters. A wrong order means the most
/// important message gets cut off, and no compiler catches that.
/// </summary>
public class TrayTooltipTests
{
    private static AgentStatus Status(
        bool enrolled = true,
        SyncHealth health = SyncHealth.Ok,
        int queued = 0) => new()
    {
        State = SegmentState.Active,
            Update = UpdateStatus.Idle,
        ActiveToday = TimeSpan.FromHours(3),
        ActiveThisMonth = TimeSpan.FromHours(40),
        MonthlyTargetHours = 208,
        QueueDepth = queued,
        Health = health,
        Paused = false,
        Enrolled = enrolled,
    };

    [Fact]
    public void সাইন_ইন_করা_থাকলে_চলতি_অবস্থাই_দেখায() =>
        Assert.Contains("Working", TrayTooltip.Build(Status()), StringComparison.Ordinal);

    /**
     * <b>The main test of this file.</b> When not signed in the outbox is empty, so
     * <c>SyncHealthPolicy</c> says healthy (<c>Ok</c>), and on the healthy path the
     * tooltip would say "Working · 0:00 today". So the one reason nothing was happening
     * was exactly the one invisible thing on screen.
     */
    [Fact]
    public void সাইন_ইন_না_করা_থাকলে_সেটাই_প্রথমে()
    {
        var text = TrayTooltip.Build(Status(enrolled: false));

        Assert.Contains(TrayTooltip.NotEnrolledLine, text, StringComparison.Ordinal);
        Assert.DoesNotContain("Working", text, StringComparison.Ordinal);
    }

    /// <summary>
    /// Careful: not just "Not signed in"; staff must know that <b>hours are not being
    /// recorded right now</b>, otherwise the message sounds harmless and they sign in late.
    /// </summary>
    [Fact]
    public void বার্তায়_ঘণ্টা_না_জমার_কথা_আছে() =>
        Assert.Contains(
            "not counting",
            TrayTooltip.Build(Status(enrolled: false)),
            StringComparison.OrdinalIgnoreCase);

    /**
     * Careful: revoke comes even before sign-in. Revoking deletes the token, so
     * <c>Enrolled</c> is then false, and both conditions are true. If the order flipped,
     * staff on a revoked machine would read "sign in".
     */
    [Fact]
    public void বাতিল_হলে_সাইন_ইনের_কথা_নয়()
    {
        var text = TrayTooltip.Build(
            Status(enrolled: false, health: SyncHealth.Revoked));

        Assert.Contains(TrayTooltip.RevokedLine, text, StringComparison.Ordinal);
        Assert.DoesNotContain("Sign in", text, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Careful: the tooltip can never be empty; an empty szTip means nothing on hover.
    /// </summary>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void টুলটিপ_কখনো_খালি_নয়(bool enrolled) =>
        Assert.False(string.IsNullOrWhiteSpace(TrayTooltip.Build(Status(enrolled))));

    /// <summary>The 63-character limit of Win32 <c>NOTIFYICONDATA.szTip</c>.</summary>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void সীমার_মধ্যে_থাকে(bool enrolled) =>
        Assert.True(TrayTooltip.Build(Status(enrolled)).Length <= TrayTooltip.MaxLength);
}
