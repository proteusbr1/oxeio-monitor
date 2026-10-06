using oXeio.Core.Agent;

namespace oXeio.Agent.Sync;

/// <summary>
/// Every knob of <see cref="HttpSyncClient"/> in one place. They live here rather than
/// scattered in code because the timeout and rate-limit numbers are related to each other;
/// changing one without looking at the other is dangerous (see the comments below).
///
/// Careful: there is deliberately no token or secret here. The token comes through
/// <see cref="IDeviceTokenSource"/>; the secrets module owns it.
/// </summary>
internal sealed record SyncClientOptions
{
    /// <summary>
    /// The server's base URL, e.g. <c>https://monitor.example.com/api/v1</c>.
    ///
    /// Careful: without a trailing '/', <see cref="Uri"/>'s relative-join rules <b>cut off</b>
    /// the last segment: "…/api/v1" + "agent/segments" = "…/api/agent/segments".
    /// So the client appends the '/' itself, even if the config is wrong.
    /// </summary>
    public required Uri BaseAddress { get; init; }

    /// <summary>Goes in the User-Agent header, so the server log shows which agent is talking.</summary>
    public string AgentVersion { get; init; } = "0.0.0";

    // ── timeouts ────────────────────────────────────────────────────────────
    //
    // Careful: HttpClient.Timeout is not used (it is set to Infinite). It is a single value
    // for the whole client, but a heartbeat and a 5 MiB upload do not tolerate the same time.
    // Each call has its own CancellationTokenSource.

    /// <summary>enroll / config / heartbeat / update-check: small JSON, expected to be fast.</summary>
    public TimeSpan ControlTimeout { get; init; } = TimeSpan.FromSeconds(20);

    /// <summary>A batch of 500 records. Even on slow ADSL ~200 KB goes through in a minute.</summary>
    public TimeSpan IngestTimeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>
    /// One .webp upload.
    ///
    /// Important: this number is tied to the slot length: 3 monitors x 60 seconds = 3 minutes,
    /// so even in the worst case the hands are free before the 5 minute slot ends.
    /// If it were raised, one hung connection would also block the next slot's screenshots,
    /// and the queue would keep growing every slot.
    /// </summary>
    public TimeSpan ScreenshotTimeout { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>MSI download: work outside the queue, so a long time can be allowed.</summary>
    public TimeSpan DownloadTimeout { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>How long to wait for TCP/TLS. If the line is dead, better to give up fast and retry.</summary>
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(10);

    /// <summary>
    /// The only fix for DNS problems in a process that runs for weeks on end.
    /// A static <c>HttpClient</c> holds on to its connection pool and never looks at DNS
    /// again; if the server's IP changed (new reverse proxy, DHCP) the agent would keep
    /// hitting the wrong address forever. When this lifetime ends the connection is dropped,
    /// so DNS is looked up again.
    /// </summary>
    public TimeSpan PooledConnectionLifetime { get; init; } = TimeSpan.FromMinutes(5);

    // ── rate limits ─────────────────────────────────────────────────────────

    /// <summary>
    /// segments / app-usage / events: how many requests per minute.
    ///
    /// Important: the server's limit is <see cref="SyncLimits.RateLimitIngestPerMinute"/> = 60.
    /// We use 55 on purpose; the other 5 are set aside for the heartbeat (one every 30
    /// seconds, i.e. 2/minute), config reload and update-check. If those went through the
    /// same limiter, the heartbeat would be stuck while draining the queue and the dashboard
    /// would show the machine as "offline" even though it is uploading flat out.
    ///
    /// For a 50,000-row backlog: 50,000 / 500 (MaxBatchSize) = 100 requests;
    /// 100 / 55 is about 1.8 minutes. So it all goes through without a single 429.
    /// </summary>
    public int IngestPermitsPerMinute { get; init; } = 55;

    /// <summary>
    /// The server's limit is <see cref="SyncLimits.RateLimitScreenshotPerMinute"/> = 20;
    /// we use 18, because running right at the limit gives a 429 on the slightest clock
    /// mismatch.
    ///
    /// The numbers: at most 2 monitors x 12 slots/hour x 16 hours = 384 screenshots a day.
    /// At 18/minute that is ~22 minutes. After seven days offline it is 2,688, about two and a
    /// half hours; it finishes by itself once the line is back, and nobody has to do anything.
    /// </summary>
    public int ScreenshotPermitsPerMinute { get; init; } = 18;

    /// <summary>
    /// A download larger than this is stopped.
    /// Careful: without it a wrong route (an HTML stream) could fill the disk, and then the
    /// outbox could not write anything, which means lost data.
    /// </summary>
    public long MaxUpdateBytes { get; init; } = 256L * 1024 * 1024;

    /// <summary>
    /// The SPKI hash of the server's certificate (base64), comma separated.
    /// When empty, pinning is off, and Windows's own validation is the only safeguard.
    /// </summary>
    public string? ServerPin { get; init; }

    /// <summary>From a string URL: an easy way to read from a config file.</summary>
    public static SyncClientOptions For(string baseUrl, string agentVersion = "0.0.0") =>
        new() { BaseAddress = new Uri(baseUrl, UriKind.Absolute), AgentVersion = agentVersion };
}
