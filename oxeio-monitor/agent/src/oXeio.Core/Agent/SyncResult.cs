namespace oXeio.Core.Agent;

/// <summary>
/// The result of every <see cref="ISyncClient"/> call.
///
/// Exceptions are never thrown from here: a network failure is not an exception in this
/// system but a normal state (a site's line stays down for days on end). Throwing would
/// force the sync loop to be wrapped in try/catch, and one missed catch would kill the whole
/// worker thread, which nobody would notice for about a week.
/// </summary>
/// <typeparam name="T">What comes back on success. <see cref="NoContent"/> if nothing does.</typeparam>
public sealed record SyncResult<T> where T : class
{
    public required SyncOutcome Outcome { get; init; }

    /// <summary>
    /// Filled when <see cref="SyncOutcome.Success"/>. The one exception is
    /// <see cref="ISyncClient.CheckUpdateAsync"/>, where 204 means "nothing new" and this is null.
    /// </summary>
    public T? Value { get; init; }

    /// <summary>The status if a response arrived; null if not. For the log.</summary>
    public int? StatusCode { get; init; }

    /// <summary>A human-readable reason: goes to the log and the tray tooltip.</summary>
    public string? Detail { get; init; }

    /// <summary>
    /// The server's <c>Retry-After</c> header (429/503). If present it must be honored instead
    /// of <see cref="RetryPolicy"/>'s own calculation.
    /// </summary>
    public TimeSpan? RetryAfter { get; init; }

    public bool IsSuccess => Outcome == SyncOutcome.Success;

    public static SyncResult<T> Ok(T? value, int? statusCode = 200) =>
        new() { Outcome = SyncOutcome.Success, Value = value, StatusCode = statusCode };

    public static SyncResult<T> Transient(int? statusCode, string? detail, TimeSpan? retryAfter = null) =>
        new()
        {
            Outcome = SyncOutcome.Transient,
            StatusCode = statusCode,
            Detail = detail,
            RetryAfter = retryAfter,
        };

    public static SyncResult<T> Permanent(int? statusCode, string? detail) =>
        new() { Outcome = SyncOutcome.Permanent, StatusCode = statusCode, Detail = detail };

    public static SyncResult<T> Revoked(string? detail = null) =>
        new() { Outcome = SyncOutcome.Revoked, StatusCode = 403, Detail = detail };
}

/// <summary>
/// To express "nothing comes back". <c>SyncResult&lt;void&gt;</c> cannot be written in C#,
/// and with <c>SyncResult&lt;object&gt;</c> nobody would know what was supposed to be there.
/// </summary>
public sealed record NoContent
{
    public static readonly NoContent Value = new();

    private NoContent() { }
}
