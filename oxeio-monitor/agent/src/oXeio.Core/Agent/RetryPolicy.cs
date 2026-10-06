namespace oXeio.Core.Agent;

/// <summary>
/// When a failed upload is retried: exponential backoff with jitter.
///
/// <b>The two most important decisions here:</b>
///
/// <b>1. By default <see cref="MaxAttempts"/> is null, so no data is dropped for the number of
/// attempts.</b> If a site's line is down for ten days, there will be about 2,900 attempts at
/// the 5-minute ceiling. A "give up after 20 tries" rule would then delete ten days of
/// payroll data, on exactly the machine with the most trouble. A transient failure means the
/// server has not said "no" yet; until it does, the data is kept.
/// Data shrinks for only two reasons: a permanent rejection by the server
/// (<see cref="SyncOutcome.Permanent"/>) and the disk budget (<see cref="OutboxBudget"/>).
///
/// <b>2. Jitter may exceed the ceiling, on purpose.</b> All 15 PCs sit behind one switch; when
/// the line returned they would all hit the server in the same second, exactly every 5
/// minutes. Clamping jitter to the ceiling would make them line up again at that very point.
/// </summary>
public sealed record RetryPolicy
{
    public RetryPolicy(
        TimeSpan baseDelay,
        double multiplier,
        TimeSpan maxDelay,
        double jitterRatio,
        int? maxAttempts,
        TimeSpan maxAge)
    {
        if (baseDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(baseDelay));
        if (multiplier < 1) throw new ArgumentOutOfRangeException(nameof(multiplier));
        if (maxDelay < baseDelay) throw new ArgumentOutOfRangeException(nameof(maxDelay));
        if (jitterRatio is < 0 or > 1) throw new ArgumentOutOfRangeException(nameof(jitterRatio));
        if (maxAttempts is < 1) throw new ArgumentOutOfRangeException(nameof(maxAttempts));
        if (maxAge <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(maxAge));

        BaseDelay = baseDelay;
        Multiplier = multiplier;
        MaxDelay = maxDelay;
        JitterRatio = jitterRatio;
        MaxAttempts = maxAttempts;
        MaxAge = maxAge;
    }

    /// <summary>The wait after the first failure.</summary>
    public TimeSpan BaseDelay { get; }

    /// <summary>The factor each time. Below 1 it is not backoff, so it is rejected.</summary>
    public double Multiplier { get; }

    /// <summary>The ceiling: never wait longer than this (jitter aside).</summary>
    public TimeSpan MaxDelay { get; }

    /// <summary>0.25 means ±25%.</summary>
    public double JitterRatio { get; }

    /// <summary>Null = never give up on the number of attempts. See the class comment.</summary>
    public int? MaxAttempts { get; }

    /// <summary>Once a row is this old it is no longer useful: the last safeguard.</summary>
    public TimeSpan MaxAge { get; }

    /// <summary>
    /// Starts at 5 seconds, doubles up to a 5-minute ceiling, ±25% jitter, no limit on
    /// attempts, and a row is dropped once older than 30 days.
    ///
    /// Why 30 days: the monthly accounting cycle is 30 days. Even if data older than that
    /// reached the server, that month's report has long since gone out.
    /// </summary>
    public static RetryPolicy Default { get; } = new(
        baseDelay: TimeSpan.FromSeconds(5),
        multiplier: 2,
        maxDelay: TimeSpan.FromMinutes(5),
        jitterRatio: 0.25,
        maxAttempts: null,
        maxAge: TimeSpan.FromDays(30));

    /// <summary>
    /// Pure backoff without jitter. <paramref name="attempt"/> = how many failures so far
    /// (1 = the first failure).
    ///
    /// If <paramref name="attempt"/> is below 1 it is treated as 1, not an exception.
    /// This is the recovery path: after everything has fallen apart <b>this</b> code must
    /// still run. Throwing here would kill the sync worker, and then data would never go out.
    /// </summary>
    public TimeSpan DelayFor(int attempt)
    {
        if (attempt < 1) attempt = 1;

        // Math.Pow(2, 2880) = infinity, and TimeSpan.FromSeconds(infinity) throws
        // OverflowException. Ten days offline is enough to reach that attempt count, so the
        // ceiling must be applied on the double before building a TimeSpan.
        var seconds = BaseDelay.TotalSeconds * Math.Pow(Multiplier, attempt - 1);

        return double.IsNaN(seconds) || seconds >= MaxDelay.TotalSeconds
            ? MaxDelay
            : TimeSpan.FromSeconds(seconds);
    }

    /// <summary>
    /// With jitter. <paramref name="jitterSample"/> is in [0,1]: the caller passes
    /// <c>Random.Shared.NextDouble()</c>, tests pass fixed values.
    /// 0.5 returns exactly <see cref="DelayFor(int)"/>.
    ///
    /// <c>Random</c> is deliberately kept out of Core: with randomness inside, this class
    /// could not be tested.
    /// </summary>
    public TimeSpan DelayFor(int attempt, double jitterSample)
    {
        var delay = DelayFor(attempt);
        if (JitterRatio <= 0) return delay;

        var sample = double.IsNaN(jitterSample) ? 0.5 : Math.Clamp(jitterSample, 0, 1);
        var factor = 1 - JitterRatio + (2 * JitterRatio * sample);
        var seconds = delay.TotalSeconds * factor;

        // Jitter must not produce a zero or negative delay, or the sync loop would become a
        // busy loop and eat a core.
        return TimeSpan.FromSeconds(Math.Max(0.001, seconds));
    }

    /// <summary>
    /// If the server sends <c>Retry-After</c> it is honored, when our own value is smaller.
    ///
    /// When the server says "come back in 60 seconds" on a 429, returning after 5 seconds and
    /// getting another 429 only fills the rate-limit counter further: shooting ourselves in the foot.
    /// </summary>
    public TimeSpan DelayFor(int attempt, double jitterSample, TimeSpan? serverRetryAfter)
    {
        var mine = DelayFor(attempt, jitterSample);
        return serverRetryAfter is { } theirs && theirs > mine ? theirs : mine;
    }

    /// <summary>The time of the next attempt: goes straight to <see cref="IOutboxStore.RetryAsync"/>.</summary>
    public DateTimeOffset NextAttemptAt(
        int attempt, DateTimeOffset now, double jitterSample, TimeSpan? serverRetryAfter = null) =>
        now + DelayFor(attempt, jitterSample, serverRetryAfter);

    /// <summary>
    /// Is it still worth keeping the row?
    ///
    /// Call this only for <see cref="SyncOutcome.Transient"/>. For
    /// <see cref="SyncOutcome.Permanent"/> abandon without looking at it, and for
    /// <see cref="SyncOutcome.Success"/> the question does not arise.
    /// </summary>
    /// <param name="attempt">How many failures so far (<see cref="OutboxEntry.Attempts"/>).</param>
    /// <param name="enqueuedAt">When the record was created, not the time of the last attempt.</param>
    public bool ShouldAbandon(int attempt, DateTimeOffset enqueuedAt, DateTimeOffset now)
    {
        if (MaxAttempts is { } cap && attempt >= cap) return true;

        return now - enqueuedAt >= MaxAge;
    }
}
