namespace oXeio.Core.Agent;

/// <summary>
/// What the server will not accept: a mirror of <c>server/src/agent/agent.constants.ts</c>.
///
/// The numbers are kept here so the agent can refuse <b>before sending</b>. Letting the server
/// answer 413 means uploading 5 MiB only to learn it will not be taken; at a site on mobile
/// broadband that wastes hundreds of megabytes a day.
/// </summary>
public static class SyncLimits
{
    /// <summary>The most records in one batch: <c>MAX_BATCH_SIZE</c>.</summary>
    public const int MaxBatchSize = 500;

    /// <summary>The maximum size of one .webp. Larger gets a 413 = permanent rejection.</summary>
    public const long MaxScreenshotBytes = 5L * 1024 * 1024;

    public const string ScreenshotMimeType = "image/webp";

    /// <summary>The agent's own clock: the server measures drift from it. On every request, GETs included.</summary>
    public const string ClientTimeHeader = "x-client-time";

    /// <summary>
    /// ISO-8601 round-trip. Usage:
    /// <c>DateTimeOffset.UtcNow.ToString(SyncLimits.ClientTimeFormat, CultureInfo.InvariantCulture)</c>
    ///
    /// Do not hand-write <c>"yyyy-MM-ddTHH:mm:ssZ"</c>: in a custom format ':' and '.' are
    /// culture-dependent separators, and .NET does not take 'Z' literally. "O" avoids all this.
    /// </summary>
    public const string ClientTimeFormat = "O";

    /// <summary>Per device, per minute. Beyond this, 429.</summary>
    public const int RateLimitIngestPerMinute = 60;

    /// <inheritdoc cref="RateLimitIngestPerMinute"/>
    public const int RateLimitScreenshotPerMinute = 20;
}
