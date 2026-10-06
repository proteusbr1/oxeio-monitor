using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class RetryPolicyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);

    // ── backoff steps ───────────────────────────────────────────────────────

    [Fact]
    public void The_first_failure_uses_the_base_delay()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.Default.DelayFor(1));
    }

    [Theory]
    [InlineData(1, 5.0)]
    [InlineData(2, 10.0)]
    [InlineData(3, 20.0)]
    [InlineData(4, 40.0)]
    [InlineData(5, 80.0)]
    public void Each_attempt_doubles_the_delay(int attempt, double seconds)
    {
        Assert.Equal(TimeSpan.FromSeconds(seconds), RetryPolicy.Default.DelayFor(attempt));
    }

    [Fact]
    public void The_delay_never_exceeds_the_ceiling()
    {
        // 5 x 2^9 = 2560 seconds, but the ceiling is 5 minutes
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Default.DelayFor(10));
    }

    /// <summary>
    /// After ten days offline the attempt count reaches several thousand. Math.Pow then
    /// gives infinity, and TimeSpan.FromSeconds(infinity) throws OverflowException, so the
    /// sync worker of exactly the machine with the most accumulated data would die.
    /// </summary>
    [Fact]
    public void Many_attempts_do_not_overflow()
    {
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Default.DelayFor(5_000));
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Default.DelayFor(int.MaxValue));
    }

    /// <summary>Throwing on the recovery path means the data never goes out again.</summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void An_impossible_attempt_number_falls_back_to_the_first_step_without_throwing(int attempt)
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.Default.DelayFor(attempt));
    }

    // ── jitter ──────────────────────────────────────────────────────────────

    [Fact]
    public void Mid_range_jitter_returns_the_plain_delay()
    {
        Assert.Equal(
            RetryPolicy.Default.DelayFor(3),
            RetryPolicy.Default.DelayFor(3, 0.5));
    }

    [Fact]
    public void Jitter_stays_within_plus_or_minus_twenty_five_percent()
    {
        // attempt 3 → 20 seconds, ±25% → 15 to 25
        Assert.Equal(TimeSpan.FromSeconds(15), RetryPolicy.Default.DelayFor(3, 0));
        Assert.Equal(TimeSpan.FromSeconds(25), RetryPolicy.Default.DelayFor(3, 1));
    }

    [Theory]
    [InlineData(-5.0)]
    [InlineData(7.0)]
    [InlineData(double.NaN)]
    public void The_delay_stays_sane_even_with_a_bad_jitter_sample(double sample)
    {
        var delay = RetryPolicy.Default.DelayFor(3, sample);

        Assert.InRange(delay, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(25));
    }

    /// <summary>
    /// If jitter produced a negative or zero delay the sync loop would become a busy
    /// loop and eat a core; on an office PC that would show as nothing but a spinning fan.
    /// </summary>
    [Fact]
    public void Jitter_never_produces_a_zero_delay()
    {
        var full = new RetryPolicy(
            TimeSpan.FromSeconds(1), 2, TimeSpan.FromSeconds(10), 1.0, null, TimeSpan.FromDays(1));

        Assert.True(full.DelayFor(1, 0) > TimeSpan.Zero);
    }

    /// <summary>
    /// Deliberate: 15 PCs sit behind the same switch, and if they were clamped to the
    /// ceiling they would line up in one queue again right there.
    /// </summary>
    [Fact]
    public void Jitter_applies_above_the_ceiling_too()
    {
        var atCeiling = RetryPolicy.Default.DelayFor(50, 1);

        Assert.True(atCeiling > TimeSpan.FromMinutes(5));
    }

    // ── Retry-After ─────────────────────────────────────────────────────────

    [Fact]
    public void A_larger_server_Retry_After_is_honoured()
    {
        var delay = RetryPolicy.Default.DelayFor(1, 0.5, TimeSpan.FromMinutes(30));

        Assert.Equal(TimeSpan.FromMinutes(30), delay);
    }

    [Fact]
    public void A_smaller_server_Retry_After_leaves_our_own_delay()
    {
        var delay = RetryPolicy.Default.DelayFor(6, 0.5, TimeSpan.FromSeconds(1));

        Assert.Equal(RetryPolicy.Default.DelayFor(6), delay);
    }

    [Fact]
    public void NextAttemptAt_falls_after_the_current_time()
    {
        var at = RetryPolicy.Default.NextAttemptAt(2, T0, 0.5);

        Assert.Equal(T0 + TimeSpan.FromSeconds(10), at);
    }

    // ── when it gives up ────────────────────────────────────────────────────

    /// <summary>
    /// A ten-day line outage means ~2,900 attempts. A rule like "give up after 20
    /// tries" would then delete ten days of payroll data.
    /// </summary>
    [Fact]
    public void By_default_it_never_gives_up_on_attempt_count()
    {
        Assert.Null(RetryPolicy.Default.MaxAttempts);
        Assert.False(RetryPolicy.Default.ShouldAbandon(100_000, T0, T0 + TimeSpan.FromDays(29)));
    }

    [Fact]
    public void With_a_cap_set_it_gives_up_on_attempt_count_too()
    {
        var capped = new RetryPolicy(
            TimeSpan.FromSeconds(5), 2, TimeSpan.FromMinutes(5), 0.25, 3, TimeSpan.FromDays(30));

        Assert.False(capped.ShouldAbandon(2, T0, T0));
        Assert.True(capped.ShouldAbandon(3, T0, T0));
    }

    [Fact]
    public void It_gives_up_when_the_age_limit_passes()
    {
        Assert.False(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(29)));
        Assert.True(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(30)));
    }

    /// <summary>
    /// Age is measured from the time of <b>creation</b>, not from the last attempt.
    /// </summary>
    [Fact]
    public void Age_is_measured_from_creation_not_from_the_last_attempt()
    {
        Assert.True(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(31)));
    }

    [Fact]
    public void Impossible_settings_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new RetryPolicy(
            TimeSpan.Zero, 2, TimeSpan.FromMinutes(5), 0.25, null, TimeSpan.FromDays(30)));

        // the ceiling is smaller than the base
        Assert.Throws<ArgumentOutOfRangeException>(() => new RetryPolicy(
            TimeSpan.FromMinutes(1), 2, TimeSpan.FromSeconds(5), 0.25, null, TimeSpan.FromDays(30)));

        // multiplier < 1 would make the delay shrink: the opposite of backoff
        Assert.Throws<ArgumentOutOfRangeException>(() => new RetryPolicy(
            TimeSpan.FromSeconds(5), 0.5, TimeSpan.FromMinutes(5), 0.25, null, TimeSpan.FromDays(30)));

        Assert.Throws<ArgumentOutOfRangeException>(() => new RetryPolicy(
            TimeSpan.FromSeconds(5), 2, TimeSpan.FromMinutes(5), 1.5, null, TimeSpan.FromDays(30)));
    }

    // ── HTTP status → outcome ───────────────────────────────────────────────

    [Theory]
    [InlineData(200)]
    [InlineData(201)]
    [InlineData(204)]
    public void The_2xx_range_is_success(int status)
    {
        Assert.Equal(SyncOutcome.Success, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Theory]
    [InlineData(500)]
    [InlineData(502)]
    [InlineData(503)]
    [InlineData(504)]
    [InlineData(429)]
    [InlineData(408)]
    public void Server_trouble_is_transient(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    /// <summary>The record itself is bad; sending it again would get the same answer.</summary>
    [Theory]
    [InlineData(400)]
    [InlineData(415)]
    [InlineData(422)]
    [InlineData(413)]
    public void A_fault_in_the_record_is_permanent(int status)
    {
        Assert.Equal(SyncOutcome.Permanent, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Fact]
    public void A_403_with_a_revoke_body_revokes_the_device()
    {
        Assert.Equal(
            SyncOutcome.Revoked,
            SyncOutcomeClassifier.FromHttpStatus(403, revokeCommandInBody: true));
    }

    /// <summary>
    /// A 403 without a revoke message is usually a proxy or auth config problem, so the data is
    /// kept.
    /// </summary>
    [Fact]
    public void A_403_without_revoke_is_only_transient()
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(403));
    }

    /// <summary>
    /// Calling 401 permanent would delete the whole queue during a token refresh.
    /// A 404 usually means a wrong base URL; once the admin fixes it the data goes through.
    /// </summary>
    [Theory]
    [InlineData(401)]
    [InlineData(404)]
    public void Auth_or_route_trouble_does_not_discard_data(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(999)]
    public void An_unknown_status_gives_the_data_the_benefit_of_the_doubt(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Fact]
    public void No_response_at_all_is_transient()
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromTransportFailure());
    }
}
