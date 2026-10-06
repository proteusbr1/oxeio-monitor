using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class RetryPolicyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);

    // ── backoff steps ───────────────────────────────────────────────────────

    [Fact]
    public void প্রথম_ব্যর্থতায়_base_delay()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.Default.DelayFor(1));
    }

    [Theory]
    [InlineData(1, 5.0)]
    [InlineData(2, 10.0)]
    [InlineData(3, 20.0)]
    [InlineData(4, 40.0)]
    [InlineData(5, 80.0)]
    public void প্রতিবার_দ্বিগুণ_হয়(int attempt, double seconds)
    {
        Assert.Equal(TimeSpan.FromSeconds(seconds), RetryPolicy.Default.DelayFor(attempt));
    }

    [Fact]
    public void সিলিং_ছাড়ায়_না()
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
    public void বহু_চেষ্টার_পরেও_overflow_হয়_না()
    {
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Default.DelayFor(5_000));
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.Default.DelayFor(int.MaxValue));
    }

    /// <summary>Throwing on the recovery path means the data never goes out again.</summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public void অসম্ভব_attempt_এ_throw_না_করে_প্রথম_ধাপ_ধরে(int attempt)
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.Default.DelayFor(attempt));
    }

    // ── jitter ──────────────────────────────────────────────────────────────

    [Fact]
    public void jitter_মাঝামাঝি_হলে_মূল_বিলম্বই_ফেরে()
    {
        Assert.Equal(
            RetryPolicy.Default.DelayFor(3),
            RetryPolicy.Default.DelayFor(3, 0.5));
    }

    [Fact]
    public void jitter_পঁচিশ_শতাংশের_দুই_পাশে_থাকে()
    {
        // attempt 3 → 20 seconds, ±25% → 15 to 25
        Assert.Equal(TimeSpan.FromSeconds(15), RetryPolicy.Default.DelayFor(3, 0));
        Assert.Equal(TimeSpan.FromSeconds(25), RetryPolicy.Default.DelayFor(3, 1));
    }

    [Theory]
    [InlineData(-5.0)]
    [InlineData(7.0)]
    [InlineData(double.NaN)]
    public void বাজে_jitter_নমুনাতেও_বিলম্ব_যুক্তিসঙ্গত_থাকে(double sample)
    {
        var delay = RetryPolicy.Default.DelayFor(3, sample);

        Assert.InRange(delay, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(25));
    }

    /// <summary>
    /// If jitter produced a negative or zero delay the sync loop would become a busy
    /// loop and eat a core; on an office PC that would show as nothing but a spinning fan.
    /// </summary>
    [Fact]
    public void jitter_কখনো_শূন্য_বিলম্ব_দেয়_না()
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
    public void সিলিংয়ের_ওপরেও_jitter_কাজ_করে()
    {
        var atCeiling = RetryPolicy.Default.DelayFor(50, 1);

        Assert.True(atCeiling > TimeSpan.FromMinutes(5));
    }

    // ── Retry-After ─────────────────────────────────────────────────────────

    [Fact]
    public void সার্ভারের_retry_after_বড়_হলে_সেটাই_মানা_হয়()
    {
        var delay = RetryPolicy.Default.DelayFor(1, 0.5, TimeSpan.FromMinutes(30));

        Assert.Equal(TimeSpan.FromMinutes(30), delay);
    }

    [Fact]
    public void সার্ভারের_retry_after_ছোট_হলে_নিজের_হিসাবই_চলে()
    {
        var delay = RetryPolicy.Default.DelayFor(6, 0.5, TimeSpan.FromSeconds(1));

        Assert.Equal(RetryPolicy.Default.DelayFor(6), delay);
    }

    [Fact]
    public void NextAttemptAt_এখনকার_সময়ের_পরে_পড়ে()
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
    public void ডিফল্টে_চেষ্টার_সংখ্যায়_হাল_ছাড়া_হয়_না()
    {
        Assert.Null(RetryPolicy.Default.MaxAttempts);
        Assert.False(RetryPolicy.Default.ShouldAbandon(100_000, T0, T0 + TimeSpan.FromDays(29)));
    }

    [Fact]
    public void সীমা_বেঁধে_দিলে_চেষ্টার_সংখ্যাতেও_হাল_ছাড়ে()
    {
        var capped = new RetryPolicy(
            TimeSpan.FromSeconds(5), 2, TimeSpan.FromMinutes(5), 0.25, 3, TimeSpan.FromDays(30));

        Assert.False(capped.ShouldAbandon(2, T0, T0));
        Assert.True(capped.ShouldAbandon(3, T0, T0));
    }

    [Fact]
    public void মেয়াদ_পেরোলে_হাল_ছাড়ে()
    {
        Assert.False(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(29)));
        Assert.True(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(30)));
    }

    /// <summary>
    /// Age is measured from the time of <b>creation</b>, not from the last attempt.
    /// </summary>
    [Fact]
    public void বয়স_শেষ_চেষ্টা_নয়_তৈরির_সময়_থেকে_মাপা_হয়()
    {
        Assert.True(RetryPolicy.Default.ShouldAbandon(1, T0, T0 + TimeSpan.FromDays(31)));
    }

    [Fact]
    public void অসম্ভব_সেটিং_নাকচ_হয়()
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
    public void দুইশোর_ঘর_সফল(int status)
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
    public void সার্ভারের_গোলমাল_সাময়িক(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    /// <summary>The record itself is bad; sending it again would get the same answer.</summary>
    [Theory]
    [InlineData(400)]
    [InlineData(415)]
    [InlineData(422)]
    [InlineData(413)]
    public void রেকর্ডের_দোষ_হলে_স্থায়ী(int status)
    {
        Assert.Equal(SyncOutcome.Permanent, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Fact]
    public void revoke_বডি_সহ_৪০৩_হলে_ডিভাইস_বাতিল()
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
    public void revoke_ছাড়া_৪০৩_শুধু_সাময়িক()
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
    public void অথ_বা_রুটের_গোলমালে_ডেটা_ফেলে_দেওয়া_হয়_না(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(999)]
    public void অজানা_ফলাফলে_সন্দেহের_সুবিধা_ডেটাই_পায়(int status)
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromHttpStatus(status));
    }

    [Fact]
    public void রেসপন্সই_না_এলে_সাময়িক()
    {
        Assert.Equal(SyncOutcome.Transient, SyncOutcomeClassifier.FromTransportFailure());
    }
}
