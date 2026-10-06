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
    public void Nothing_but_the_domain_goes_out(string? input, string? expected) =>
        Assert.Equal(expected, SyncWire.DomainOnly(input));

    /// <summary>
    /// The ':' inside an IPv6 literal is not a port; trimming it would ruin the address.
    /// </summary>
    [Fact]
    public void An_IPv6_literal_stays_intact() =>
        Assert.Equal("[::1]", SyncWire.DomainOnly("http://[::1]/admin"));

    /// <summary>
    /// <summary>
    /// Even if a bug in some module supplies a full URL, it must not land in the database.
    /// </summary>
    /// </summary>
    [Fact]
    public void Even_a_full_URL_puts_only_the_domain_on_the_wire()
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
    public void Nothing_longer_than_the_server_limit_goes_out()
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
    public void Values_within_the_limit_are_unchanged()
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
    public void The_segment_state_goes_out_in_lower_case(SegmentState state, string wire) =>
        Assert.Equal(wire, SyncWire.StateToWire(state));

    [Fact]
    public void An_unknown_state_is_never_sent_silently() =>
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
    /// ([G71](../../../../docs/history/08-Gap-Analysis.md)). Now they are filled, and this is the guard.
    /// </summary>
    [Fact]
    public void The_app_and_title_go_out_with_the_screenshot()
    {
        var dto = Shot("excel.exe", "Q3 budget.xlsx");

        Assert.Equal("excel.exe", dto.ActiveApp);
        Assert.Equal("Q3 budget.xlsx", dto.ActiveTitle);
    }

    /// <summary>With app tracking off nothing is known, so sending empty is correct.</summary>
    [Fact]
    public void Unknown_values_go_out_empty()
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
    public void A_long_title_or_name_is_trimmed_to_the_limit()
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
