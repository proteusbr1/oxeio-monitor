using oXeio.Core.Apps;
using oXeio.Core.Models;

namespace oXeio.Core.Tests;

public class AppUsageTrackerTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 10, 10, 0, 0, TimeSpan.FromHours(6));

    private static WindowSample App(string process, string? title = null) =>
        new() { ProcessName = process, WindowTitle = title };

    private static WindowSample Browser(string url, string? title = null) =>
        new()
        {
            ProcessName = "chrome.exe",
            AppName = "Google Chrome",
            WindowTitle = title,
            RawUrl = url,
            IsBrowser = true,
        };

    private static AppUsageTracker New() => new();

    [Fact]
    public void একই_অ্যাপে_থাকলে_একটাই_রেকর্ড()
    {
        var t = New();

        t.Observe(App("code.exe"), T0, SegmentState.Active);
        t.Observe(App("code.exe"), T0.AddSeconds(30), SegmentState.Active);
        var closed = t.Observe(App("excel.exe"), T0.AddSeconds(60), SegmentState.Active);

        var r = Assert.Single(closed);
        Assert.Equal("code.exe", r.ProcessName);
        Assert.Equal(60, r.DurationSec);
    }

    /// <summary>
    /// D04. Someone alt-tabbing to look for a file touches ten windows; if each were
    /// recorded, the real picture in the report would be buried.
    /// </summary>
    [Fact]
    public void পাঁচ_সেকেন্ডের_কম_হলে_রেকর্ড_হয়_না()
    {
        var t = New();
        var all = new List<oXeio.Core.Agent.AppUsageRecord>();

        for (var i = 0; i < 10; i++)
            all.AddRange(t.Observe(App($"app{i}.exe"), T0.AddSeconds(i), SegmentState.Active));

        all.AddRange(t.CloseAll(T0.AddSeconds(10)));

        Assert.Empty(all);
    }

    [Fact]
    public void ঠিক_পাঁচ_সেকেন্ড_হলে_রেকর্ড_হয়()
    {
        var t = New();

        t.Observe(App("code.exe"), T0, SegmentState.Active);
        var closed = t.Observe(App("excel.exe"), T0.AddSeconds(5), SegmentState.Active);

        Assert.Single(closed);
        Assert.Equal(5, closed[0].DurationSec);
    }

    /// <summary>
    /// When someone goes to lunch, Excel is still open on screen. That hour is not
    /// "Excel use", and it is not counted in working time either.
    /// </summary>
    /// <summary>
    /// <b>R22a changed this contract, deliberately.</b>
    ///
    /// Before, the tracker stopped on entering idle, so there was no record at all for
    /// that time. Careful: that lost for good the answer to "what was in front during
    /// this idle time?", which is the only clue for recognizing meetings (in Zoom the
    /// keyboard is quiet, yet the person is working).
    ///
    /// <b>The rule "leaving Excel open at lunch is not work" did not break</b>; it only
    /// moved: the record is stored with <c>State = Idle</c>, and every read on the
    /// server filters only ACTIVE. <b>Being recorded</b> and <b>being counted</b> are
    /// two different things.
    /// </summary>
    [Fact]
    public void নিষ্ক্রিয়_অবস্থায়ও_রেকর্ড_হয়_কিন্তু_আলাদা_চিহ্নে()
    {
        var t = New();

        t.Observe(App("excel.exe"), T0, SegmentState.Active);

        // The state changed: the ACTIVE chunk is cut right here
        var closed = t.Observe(App("excel.exe"), T0.AddSeconds(30), SegmentState.Idle);
        Assert.Single(closed);
        Assert.Equal(30, closed[0].DurationSec);
        Assert.Equal(SegmentState.Active, closed[0].State);

        // Idle time is now recorded too, but marked Idle
        var more = t.Observe(App("excel.exe"), T0.AddMinutes(6), SegmentState.Idle);
        Assert.NotEmpty(more);
        Assert.All(more, r => Assert.Equal(SegmentState.Idle, r.State));
    }

    /// <summary>
    /// Careful: one record cannot be half ACTIVE and half IDLE; otherwise the question
    /// "is this time counted?" would have no single answer.
    /// </summary>
    [Fact]
    public void অবস্থা_বদলালে_খণ্ড_ওখানেই_কাটে()
    {
        var t = New();

        t.Observe(App("zoom.exe"), T0, SegmentState.Active);
        var atIdle = t.Observe(App("zoom.exe"), T0.AddSeconds(20), SegmentState.Idle);
        var backActive = t.Observe(App("zoom.exe"), T0.AddSeconds(50), SegmentState.Active);

        Assert.Single(atIdle);
        Assert.Equal(SegmentState.Active, atIdle[0].State);
        Assert.Equal(20, atIdle[0].DurationSec);

        Assert.Single(backActive);
        Assert.Equal(SegmentState.Idle, backActive[0].State);
        Assert.Equal(30, backActive[0].DurationSec);
    }

    /// <summary>In the normal state the mark is ACTIVE: the default did not change.</summary>
    [Fact]
    public void সচল_অবস্থার_রেকর্ডে_চিহ্ন_Active()
    {
        var t = New();

        t.Observe(App("code.exe"), T0, SegmentState.Active);
        var closed = t.Observe(App("excel.exe"), T0.AddSeconds(40), SegmentState.Active);

        Assert.Single(closed);
        Assert.Equal(SegmentState.Active, closed[0].State);
    }

    [Fact]
    public void লক_করা_অবস্থায়ও_গোনা_হয়_না()
    {
        var t = New();

        t.Observe(App("excel.exe"), T0, SegmentState.Active);
        t.Observe(App("excel.exe"), T0.AddSeconds(10), SegmentState.Locked);
        var more = t.Observe(App("excel.exe"), T0.AddMinutes(30), SegmentState.Locked);

        Assert.Empty(more);
    }

    // ── browser ─────────────────────────────────────────────────────────────

    /// <summary>
    /// A domain change in a browser starts a new record; otherwise there would be one
    /// "chrome.exe 8 hours" all day and D08 (top 10 sites) could not be built.
    /// </summary>
    [Fact]
    public void ডোমেইন_বদলালে_নতুন_রেকর্ড()
    {
        var t = New();

        t.Observe(Browser("https://github.com/x"), T0, SegmentState.Active);
        var closed = t.Observe(Browser("https://youtube.com/watch?v=1"), T0.AddSeconds(30), SegmentState.Active);

        var r = Assert.Single(closed);
        Assert.Equal("github.com", r.Domain);
        Assert.True(r.IsBrowser);
    }

    [Fact]
    public void একই_ডোমেইনে_টাইটেল_বদলালে_নতুন_রেকর্ড_নয়()
    {
        // Scrolling on one page also changes the title; a new row each time would
        // inflate the record count for no reason
        var t = New();

        t.Observe(Browser("https://github.com/a", "A · GitHub"), T0, SegmentState.Active);
        var closed = t.Observe(Browser("https://github.com/b", "B · GitHub"), T0.AddSeconds(30), SegmentState.Active);

        Assert.Empty(closed);
    }

    [Fact]
    public void ফুল_URL_কখনো_রেকর্ডে_ওঠে_না()
    {
        var t = New();

        t.Observe(Browser("https://bank.com/account/12345?token=SECRET"), T0, SegmentState.Active);
        var closed = t.Observe(App("code.exe"), T0.AddSeconds(30), SegmentState.Active);

        var r = Assert.Single(closed);
        Assert.Equal("bank.com", r.Domain);
        Assert.DoesNotContain("12345", r.Domain);
        Assert.DoesNotContain("SECRET", r.Domain);
    }

    /// <summary>
    /// In private browsing only "the browser was used" is kept. The title also holds
    /// the page name, so it is dropped as well; otherwise the same information would be kept
    /// indirectly.
    /// </summary>
    [Fact]
    public void ব্যক্তিগত_ব্রাউজিংয়ে_ডোমেইন_বা_টাইটেল_কিছুই_যায়_না()
    {
        var t = New();

        t.Observe(
            Browser("https://example.com/x", "example — Chrome (Incognito)"),
            T0, SegmentState.Active);
        var closed = t.Observe(App("code.exe"), T0.AddSeconds(30), SegmentState.Active);

        var r = Assert.Single(closed);
        Assert.Equal("chrome.exe", r.ProcessName);
        Assert.Null(r.Domain);
        Assert.Null(r.WindowTitle);
    }

    // ── durability ──────────────────────────────────────────────────────────

    [Fact]
    public void টানা_এক_অ্যাপে_থাকলেও_রেকর্ড_নিয়মিত_বেরোয়()
    {
        // Same as segments; otherwise a crash would lose everything (G53)
        var t = New();
        var all = new List<oXeio.Core.Agent.AppUsageRecord>();

        all.AddRange(t.Observe(App("code.exe"), T0, SegmentState.Active));
        for (var m = 1; m <= 17; m++)
            all.AddRange(t.Observe(App("code.exe"), T0.AddMinutes(m), SegmentState.Active));

        Assert.Equal(3, all.Count);
        Assert.All(all, r => Assert.Equal(300, r.DurationSec));
    }

    [Fact]
    public void ভাগ_হলেও_মোট_সময়_ঠিক_থাকে()
    {
        var t = New();
        var all = new List<oXeio.Core.Agent.AppUsageRecord>();

        all.AddRange(t.Observe(App("code.exe"), T0, SegmentState.Active));
        for (var m = 1; m <= 17; m++)
            all.AddRange(t.Observe(App("code.exe"), T0.AddMinutes(m), SegmentState.Active));
        all.AddRange(t.CloseAll(T0.AddMinutes(17)));

        Assert.Equal(17 * 60, all.Sum(r => r.DurationSec));
    }

    [Fact]
    public void প্রতিটি_রেকর্ডের_আলাদা_uuid()
    {
        var t = New();
        var all = new List<oXeio.Core.Agent.AppUsageRecord>();

        for (var m = 0; m <= 17; m++)
            all.AddRange(t.Observe(App("code.exe"), T0.AddMinutes(m), SegmentState.Active));

        Assert.Equal(all.Count, all.Select(r => r.ClientUuid).Distinct().Count());
    }

    [Fact]
    public void কোনো_উইন্ডো_না_থাকলে_খোলাটা_বন্ধ_হয়()
    {
        var t = New();

        t.Observe(App("code.exe"), T0, SegmentState.Active);
        var closed = t.Observe(null, T0.AddSeconds(20), SegmentState.Active);

        Assert.Single(closed);
        Assert.Null(t.CurrentProcess);
    }

    // ── A07: "what is in front now", to pair with the screenshot ────────────

    /// <summary>
    /// Careful: D04's 5-second rule is a rule for <b>records</b>, not for "what is in
    /// front now". The name must also sit beside a screenshot taken in the first second;
    /// otherwise the screenshots taken exactly at an app switch would stay nameless forever.
    /// </summary>
    [Fact]
    public void সামনের_উইন্ডো_প্রথম_মুহূর্ত_থেকেই_জানা_যায়()
    {
        var t = New();

        t.Observe(App("excel.exe", "Q3 budget.xlsx"), T0, SegmentState.Active);

        Assert.Equal("excel.exe", t.Current?.ProcessName);
        Assert.Equal("Q3 budget.xlsx", t.Current?.WindowTitle);
    }

    /// <summary>
    /// Screenshots are taken <b>only</b> while ACTIVE (A04), and here <c>Current</c> is
    /// empty unless ACTIVE, so "what was in front of the locked screen" can never end
    /// up paired with an image.
    /// </summary>
    [Fact]
    public void ACTIVE_ছাড়া_সামনের_উইন্ডো_বলা_হয়_না()
    {
        var t = New();

        t.Observe(App("excel.exe"), T0, SegmentState.Active);
        t.Observe(App("excel.exe"), T0.AddSeconds(10), SegmentState.Locked);

        Assert.Null(t.Current);
    }
}
