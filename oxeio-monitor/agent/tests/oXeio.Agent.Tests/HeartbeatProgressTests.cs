using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// The <c>progress</c> in the heartbeat reply: the only source of the tray's
/// "x / 208h this month".
///
/// This field was missing from the DTO, so even when the server sent the number the
/// agent silently dropped it and the tray showed <b>0 hours</b> forever. The bug was
/// silent because everything on the server side was correct; one field was simply
/// absent. J03 (goal-reached balloon) and J04 (today's total) both depend on it.
/// </summary>
public class HeartbeatProgressTests
{
    private static HeartbeatResponse Parse(string json)
    {
        var dto = SyncJson.TryDeserialize<SyncWire.HeartbeatResponseDto>(json);
        Assert.NotNull(dto);
        return SyncWire.ToHeartbeatResponse(dto!);
    }

    /// <summary>The server's <c>agent.controller.ts</c> returns exactly this shape.</summary>
    [Fact]
    public void সার্ভারের_progress_পড়া_হয()
    {
        var response = Parse(
            """
            {
              "commands": [],
              "configVersion": "abc123",
              "progress": {
                "todayActiveSec": 12600,
                "monthActiveSec": 228240,
                "monthlyTargetHours": 208
              }
            }
            """);

        Assert.NotNull(response.Progress);
        Assert.Equal(12_600, response.Progress!.TodayActiveSec);
        Assert.Equal(228_240, response.Progress.MonthActiveSec);
        Assert.Equal(208, response.Progress.MonthlyTargetHours);

        // The server does not send pace yet: it must stay null, not 0
        Assert.Null(response.Progress.PaceSec);
    }

    /// <summary>
    /// The server sends <c>null</c> when no staff member is linked to the device.
    /// </summary>
    [Fact]
    public void কর্মী_যুক্ত_না_থাকলে_null()
    {
        var response = Parse("""{"commands":[],"configVersion":"x","progress":null}""");

        Assert.Null(response.Progress);
    }

    /// <summary>
    /// Careful: a target of 0 voids the whole progress. With a zero target
    /// <see cref="AgentStatus.MonthlyProgress"/> returns 0, so the progress bar of
    /// someone who worked the whole month would look empty all month.
    /// </summary>
    [Fact]
    public void শূন্য_টার্গেট_মেনে_নেওয়া_হয_না()
    {
        var response = Parse(
            """{"progress":{"todayActiveSec":10,"monthActiveSec":20,"monthlyTargetHours":0}}""");

        Assert.Null(response.Progress);
    }

    /// <summary>
    /// The most important safeguard: losing one progress field must never cost a
    /// <b>command</b>. Even if the server one day drops a field or adds a new one,
    /// revoke/reload_config must still arrive.
    /// </summary>
    [Fact]
    public void progress_ভাঙা_থাকলেও_কমান্ড_পৌঁছায়()
    {
        var response = Parse(
            """
            {
              "commands": ["revoke"],
              "configVersion": "v9",
              "progress": { "monthActiveSec": 100, "somethingNew": true }
            }
            """);

        Assert.Contains(AgentCommand.Revoke, response.Commands);
        Assert.Equal("v9", response.ConfigVersion);

        // No monthlyTargetHours, so progress is not trustworthy, but the command arrived
        Assert.Null(response.Progress);
    }

    /// <summary>If the server one day sends pace, it should be used automatically (B05b).</summary>
    [Fact]
    public void paceSec_এলে_পড়া_হয()
    {
        var response = Parse(
            """
            {
              "progress": {
                "todayActiveSec": 0,
                "monthActiveSec": 100,
                "monthlyTargetHours": 208,
                "paceSec": -26640
              }
            }
            """);

        Assert.Equal(-26_640, response.Progress!.PaceSec);
    }

    /// <summary>
    /// <b>G111</b>: the server says which kind of 0 the pace 0 is.
    ///
    /// Careful: for someone with no finished workday seen yet, <c>paceSec</c> is exactly
    /// <c>0</c>, and 0 means "right on target". If the flag were not read, a new
    /// staff member's first day would show "0:00 ahead" in the tray.
    /// </summary>
    [Fact]
    public void observed_মিথ্যা_এলে_পড়া_হয()
    {
        var response = Parse(
            """
            {
              "progress": {
                "todayActiveSec": 0,
                "monthActiveSec": 0,
                "monthlyTargetHours": 208,
                "paceSec": 0,
                "observed": false
              }
            }
            """);

        Assert.Equal(0, response.Progress!.PaceSec);
        Assert.False(response.Progress.Observed);
    }

    /// <summary>
    /// Careful: <b>behavior with an old server is exactly as before.</b> If the field
    /// is absent the value is <c>null</c>, not <c>false</c>. Assuming <c>false</c> would
    /// make <b>every</b> tray say "Not observed yet" before the server update, although
    /// everyone's totals were fine: telling one truth and lying to everyone.
    /// </summary>
    [Fact]
    public void পুরোনো_সার্ভার_observed_না_পাঠালে_null()
    {
        var response = Parse(
            """
            {
              "progress": {
                "todayActiveSec": 0,
                "monthActiveSec": 100,
                "monthlyTargetHours": 208,
                "paceSec": -3600
              }
            }
            """);

        Assert.Null(response.Progress!.Observed);
    }
}
