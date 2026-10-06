using oXeio.Core.Watchdog;

namespace oXeio.Core.Tests;

public class AgentHeartbeatTests
{
    private static AgentHeartbeat Sample(long unbiasedMs = 5_000) => new()
    {
        Version = AgentLiveness.CurrentVersion,
        ProcessId = 4242,
        SessionId = 1,
        UnbiasedMs = unbiasedMs,
        WrittenAtUtc = new DateTimeOffset(2026, 8, 10, 9, 14, 3, TimeSpan.Zero),
    };

    // ── write <-> read ──────────────────────────────────────────────────────

    [Fact]
    public void Writing_then_reading_returns_the_same_values()
    {
        var written = Sample();

        var read = AgentLiveness.TryParse(AgentLiveness.Format(written));

        Assert.NotNull(read);
        Assert.Equal(written.Version, read.Version);
        Assert.Equal(written.ProcessId, read.ProcessId);
        Assert.Equal(written.SessionId, read.SessionId);
        Assert.Equal(written.UnbiasedMs, read.UnbiasedMs);
        Assert.Equal(written.WrittenAtUtc, read.WrittenAtUtc);
    }

    /// <summary>
    /// The whole thing on one line: the agent writes a temp file and renames it, so
    /// the line must be short and written in one go.
    /// </summary>
    [Fact]
    public void It_is_written_on_a_single_line()
    {
        var text = AgentLiveness.Format(Sample());

        Assert.DoesNotContain('\n', text);
        Assert.DoesNotContain('\r', text);
    }

    // ── malformed input ─────────────────────────────────────────────────────

    /// <summary>
    /// A half-written file (the agent died mid-write) must not be read as a "heartbeat
    /// 0 ms old"; that would make a dead agent look healthy forever.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("v=1 pid=4242")]                       // no unbiased
    [InlineData("pid=4242 unbiased=5000")]             // no v
    [InlineData("v=1 pid=0 unbiased=5000")]            // pid impossible
    [InlineData("v=1 pid=-3 unbiased=5000")]
    [InlineData("v=1 pid=4242 unbiased=-1")]
    [InlineData("v=1 pid=abc unbiased=5000")]
    [InlineData("καθόλου αριθμός")]
    [InlineData("=====")]
    public void A_malformed_line_returns_null(string? line)
    {
        Assert.Null(AgentLiveness.TryParse(line));
    }

    /// <summary>
    /// Careful: if the agent is updated and adds a new field, an old watchdog must not
    /// fail to parse and throw the whole fleet into a restart loop. The moment of an
    /// update is the most fragile one.
    /// </summary>
    [Fact]
    public void Unknown_fields_are_ignored()
    {
        var read = AgentLiveness.TryParse(
            "v=2 pid=4242 session=1 unbiased=5000 queue=17 build=deadbeef utc=2026-08-10T09:14:03.0000000Z");

        Assert.NotNull(read);
        Assert.Equal(2, read.Version);
        Assert.Equal(5_000, read.UnbiasedMs);
    }

    [Fact]
    public void Optional_fields_may_be_missing()
    {
        var read = AgentLiveness.TryParse("v=1 pid=4242 unbiased=5000");

        Assert.NotNull(read);
        Assert.Equal(0u, read.SessionId);
        Assert.Equal(DateTimeOffset.MinValue, read.WrittenAtUtc);
    }

    // ── age ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Age_is_the_difference_of_the_unbiased_clock()
    {
        var age = AgentLiveness.Age(Sample(unbiasedMs: 5_000), nowUnbiasedMs: 12_000);

        Assert.Equal(TimeSpan.FromSeconds(7), age);
    }

    /// <summary>
    /// After a reboot the heartbeat file stays on disk but the unbiased counter starts
    /// from zero, so the file's value is "in the future". If that were treated as fresh,
    /// the watchdog would think a dead agent was healthy and never start it, so after a
    /// reboot nobody's time would be counted.
    /// </summary>
    [Fact]
    public void No_age_is_given_for_a_heartbeat_from_a_previous_boot()
    {
        Assert.Null(AgentLiveness.Age(Sample(unbiasedMs: 900_000), nowUnbiasedMs: 4_000));
    }

    [Fact]
    public void At_the_same_instant_the_age_is_zero()
    {
        Assert.Equal(TimeSpan.Zero, AgentLiveness.Age(Sample(unbiasedMs: 5_000), 5_000));
    }

    /// <summary>
    /// Careful: with a threshold of just two or three times the interval, an AV scan or
    /// a long GC pause would get a healthy agent killed. The 8x interval is deliberate.
    /// </summary>
    [Fact]
    public void The_stale_limit_is_many_times_the_interval()
    {
        Assert.True(AgentLiveness.StaleAfter >= AgentLiveness.HeartbeatInterval * 6);
    }
}
