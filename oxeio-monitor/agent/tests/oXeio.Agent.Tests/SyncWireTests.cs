using oXeio.Agent.Sync;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Tests;

/// <summary>
/// The last gate before the wire. Whatever goes through here is what reaches the
/// server, so two things are guaranteed here: <b>never a full URL</b>, and
/// <b>nothing longer than the server's limit</b>.
/// </summary>
public class SyncWireTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 10, 10, 0, 0, TimeSpan.FromHours(6));

    private static AppUsageRecord Record(
        string process = "chrome.exe", string? app = null,
        string? title = null, string? domain = null) => new()
        {
            ClientUuid = Guid.NewGuid(),
            StartedAt = T0,
            EndedAt = T0.AddSeconds(30),
            DurationSec = 30,
            ProcessName = process,
            AppName = app,
            WindowTitle = title,
            Domain = domain,
        };

    private static SyncWire.AppUsageDto One(AppUsageRecord r) =>
        Assert.Single(SyncWire.AppUsage([r]).Items);

    // ── domain ──────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("https://bank.com/account/12345?token=SECRET", "bank.com")]
    [InlineData("http://user:pass@internal.example.com/x", "internal.example.com")]
    [InlineData("github.com:443", "github.com")]
    [InlineData("GitHub.COM", "github.com")]
    [InlineData("example.com.", "example.com")]
    [InlineData("  ", null)]
    public void ডোমেইন_ছাড়া_আর_কিছুই_যায়_না(string? input, string? expected) =>
        Assert.Equal(expected, SyncWire.DomainOnly(input));

    /// <summary>
    /// The ':' inside an IPv6 literal is not a port; trimming it would ruin the address.
    /// </summary>
    [Fact]
    public void IPv6_লিটারাল_অক্ষত_থাকে() =>
        Assert.Equal("[::1]", SyncWire.DomainOnly("http://[::1]/admin"));

    /// <summary>
    /// <summary>
    /// Even if a bug in some module supplies a full URL, it must not land in the database.
    /// </summary>
    /// </summary>
    [Fact]
    public void ফুল_URL_এলেও_তারে_শুধু_ডোমেইন_ওঠে()
    {
        var dto = One(Record(domain: "https://mail.google.com/mail/u/0/#inbox/FMfcgz"));

        Assert.Equal("mail.google.com", dto.Domain);
    }

    // ── length ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Exceeding the server's limit gets a 400, and 400 = Permanent = data deleted (G49).
    /// None of these strings is written by us, so they cannot be trusted.
    /// </summary>
    [Fact]
    public void সার্ভারের_সীমার_বেশি_লম্বা_কিছু_যায়_না()
    {
        var dto = One(Record(
            process: new string('p', 400),
            app: new string('a', 400),      // comes from the exe's version resource
            title: new string('t', 2000),
            domain: new string('d', 400)));

        Assert.Equal(260, dto.ProcessName.Length);
        Assert.Equal(260, dto.AppName!.Length);
        Assert.Equal(1000, dto.WindowTitle!.Length);
        Assert.Equal(260, dto.Domain!.Length);
    }

    [Fact]
    public void সীমার_ভেতরে_থাকলে_কিছু_বদলায়_না()
    {
        var dto = One(Record(app: "Google Chrome", title: "GitHub", domain: "github.com"));

        Assert.Equal("chrome.exe", dto.ProcessName);
        Assert.Equal("Google Chrome", dto.AppName);
        Assert.Equal("GitHub", dto.WindowTitle);
        Assert.Equal("github.com", dto.Domain);
    }

    // ── segments ────────────────────────────────────────────────────────────

    /// <summary>
    /// G49: the Prisma enum is lower case. Sending upper case got a 400, and those
    /// segments were deleted.
    /// </summary>
    [Theory]
    [InlineData(SegmentState.Active, "active")]
    [InlineData(SegmentState.Idle, "idle")]
    [InlineData(SegmentState.Locked, "locked")]
    public void সেগমেন্টের_অবস্থা_ছোট_হাতে_যায়(SegmentState state, string wire) =>
        Assert.Equal(wire, SyncWire.StateToWire(state));

    [Fact]
    public void অচেনা_অবস্থা_চুপচাপ_পাঠানো_হয়_না() =>
        Assert.Throws<ArgumentOutOfRangeException>(
            () => SyncWire.StateToWire((SegmentState)99));

    // ── screenshot meta · A07 ───────────────────────────────────────────────

    private static SyncWire.ScreenshotMetaDto Shot(string? app = null, string? title = null) =>
        SyncWire.ScreenshotMeta(new ScreenshotRecord
        {
            ClientUuid = Guid.NewGuid(),
            SlotStart = T0,
            CapturedAt = T0.AddSeconds(137),
            MonitorIndex = 0,
            ActiveApp = app,
            ActiveTitle = title,
        });

    /// <summary>
    /// A07: these fields were on the wire long ago but nobody filled them
    /// ([G71](../../../../docs/08-Gap-Analysis.md)). Now they are filled, and this is the guard.
    /// </summary>
    [Fact]
    public void ছবির_সাথে_অ্যাপ_ও_টাইটেল_তারে_ওঠে()
    {
        var dto = Shot("excel.exe", "Q3 budget.xlsx");

        Assert.Equal("excel.exe", dto.ActiveApp);
        Assert.Equal("Q3 budget.xlsx", dto.ActiveTitle);
    }

    /// <summary>With app tracking off nothing is known, so sending empty is correct.</summary>
    [Fact]
    public void না_জানা_থাকলে_ঘর_খালিই_যায়()
    {
        var dto = Shot();

        Assert.Null(dto.ActiveApp);
        Assert.Null(dto.ActiveTitle);
    }

    /// <summary>
    /// Careful: the same trap as G60, now for screenshots: the title is not written by
    /// us, and exceeding the server's limit gets a 400, which is Permanent, so the image itself
    /// would be deleted.
    /// </summary>
    [Fact]
    public void লম্বা_টাইটেল_বা_নাম_সীমায়_ছাঁটা_হয়()
    {
        var dto = Shot(new string('a', 400), new string('b', 1500));

        Assert.Equal(260, dto.ActiveApp!.Length);
        Assert.Equal(1000, dto.ActiveTitle!.Length);
    }

    // ── capability report ───────────────────────────────────────────────────

    [Fact]
    public void Heartbeat_carries_the_capability_report_as_camelCase_keys()
    {
        var dto = SyncWire.Heartbeat(new HeartbeatRequest
        {
            State = SegmentState.Active,
            ActiveSecToday = 60,
            Capabilities = new Dictionary<string, string> { ["browserDomain"] = "degraded" },
        });

        var json = SyncJson.Serialize(dto);

        Assert.Contains("\"capabilities\":{\"browserDomain\":\"degraded\"}", json);
    }

    [Fact]
    public void Heartbeat_without_a_report_sends_no_field()
    {
        var json = SyncJson.Serialize(SyncWire.Heartbeat(new HeartbeatRequest
        {
            State = SegmentState.Active,
            ActiveSecToday = 60,
        }));

        Assert.DoesNotContain("capabilities", json);
    }
}
