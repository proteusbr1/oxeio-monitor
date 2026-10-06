using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

using oXeio.Agent.Storage;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Sync;

/// <summary>
/// The only implementation of <see cref="ISyncClient"/>, on top of <c>HttpClient</c>,
/// with no third-party library.
///
/// <b>This class makes three promises:</b>
/// <list type="number">
/// <item><b>Never throws.</b> Every path returns <see cref="SyncResult{T}"/>. In this office
///       having no network is not an exception, it is the normal state.</item>
/// <item><b>Transient when in doubt.</b> Retrying by mistake keeps the queue longer for a
///       while; saying Permanent by mistake deletes someone's paid hours.</item>
/// <item><b>Stops early at the rate limit.</b> See <see cref="SlidingWindowGate"/>.</item>
/// </list>
///
/// <b>Why one HttpClient for the whole lifetime:</b>
/// creating <c>new HttpClient()</c> per call leaves every connection in <c>TIME_WAIT</c>
/// for 240 seconds even after dispose; at around a thousand calls a day the ephemeral
/// ports run out in a few days and then you get <c>SocketException</c>, while the machine
/// is an office PC that nobody is watching.
///
/// <b>But a static <c>HttpClient</c> alone is not enough either:</b> it keeps the connection
/// pool and <b>never looks at DNS again</b>. This process runs for weeks on end; if the
/// server's IP changed in that time (new reverse proxy, DHCP lease) the agent would hit a
/// dead address forever and the only fix would be restarting every PC. The solution is
/// <c>SocketsHttpHandler.PooledConnectionLifetime</c>: after a set time the connection is
/// dropped, so DNS is looked up again.
/// </summary>
internal sealed class HttpSyncClient : ISyncClient, IDisposable
{
    private const int MaxBodyBytes = 256 * 1024;
    private const int MaxDetailChars = 300;

    /// <summary>The maximum Retry-After value; see the comment below.</summary>
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromMinutes(15);

    private static readonly IngestAck EmptyAck = new() { Accepted = 0, Duplicates = 0, Split = 0 };

    private readonly SyncClientOptions _options;
    private readonly IDeviceTokenSource? _tokenSource;
    private readonly ISyncLog _log;
    private readonly HttpClient _http;
    private readonly SlidingWindowGate _ingestGate;
    private readonly SlidingWindowGate _screenshotGate;

    private string? _token;
    private bool _disposed;

    /// <param name="tokenSource">
    /// The secrets module's token. If null, only a token given through
    /// <see cref="SetDeviceToken"/> works.
    /// </param>
    /// <param name="transport">
    /// A fake handler for tests. null = the real <see cref="SocketsHttpHandler"/>.
    /// Careful: if given, this class also owns it; it is released in <see cref="Dispose"/>.
    /// </param>
    internal HttpSyncClient(
        SyncClientOptions options,
        IDeviceTokenSource? tokenSource = null,
        ISyncLog? log = null,
        HttpMessageHandler? transport = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        _options = options;
        _tokenSource = tokenSource;
        _log = log ?? NullSyncLog.Instance;

        var inner = transport ?? new SocketsHttpHandler
        {
            PooledConnectionLifetime = options.PooledConnectionLifetime,
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            ConnectTimeout = options.ConnectTimeout,

            // No more than 4 connections are needed at this load (a few requests every
            // 5 minutes), and keeping it low also keeps things tidy on the server side.
            MaxConnectionsPerServer = 4,

            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,

            // Off on purpose. On a 301/302 .NET turns a POST into a GET and drops the body, so
            // a wrong proxy redirect could silently empty our 500 segments, return 200, and we
            // would happily ack and delete them from the queue. Here a redirect comes back as
            // a 3xx and SyncOutcomeClassifier calls it Transient: the data stays, the tray
            // turns red, and an admin fixes the base URL.
            AllowAutoRedirect = false,

            // I01: when a pin is set we do the TLS validation ourselves (see the doc below)
            SslOptions = BuildSslOptions(CertificatePin.Parse(options.ServerPin), _log),
        };

        _http = new HttpClient(new SyncHeadersHandler(ResolveToken, inner), disposeHandler: true)
        {
            BaseAddress = EnsureTrailingSlash(options.BaseAddress),

            // Careful: Infinite here; the timeout is set per call (see the comments in
            // SyncClientOptions). Using HttpClient.Timeout would throw
            // OperationCanceledException, and we could not tell whether the caller cancelled or
            // the time ran out.
            Timeout = Timeout.InfiniteTimeSpan,
        };

        // Careful: TryAddWithoutValidation. A single space in the version string would make
        // ParseAdd throw FormatException, so the constructor itself would fail.
        _http.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent", $"oXeio-Agent/{options.AgentVersion}");
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");

        // With Expect: 100-continue every upload costs an extra round trip; on a mobile link
        // with 300 ms latency that is a noticeable delay per screenshot.
        _http.DefaultRequestHeaders.ExpectContinue = false;

        _ingestGate = SlidingWindowGate.PerMinute(options.IngestPermitsPerMinute);
        _screenshotGate = SlidingWindowGate.PerMinute(options.ScreenshotPermitsPerMinute);
    }

    // ── token ───────────────────────────────────────────────────────────────

    /// <summary>
    /// A token given here takes priority over <see cref="IDeviceTokenSource"/> (right after
    /// enroll, work has to continue before it is written to disk).
    /// If null is given, it goes back to the source's token.
    /// </summary>
    public void SetDeviceToken(string? deviceToken)
    {
        string? normalized = string.IsNullOrWhiteSpace(deviceToken) ? null : deviceToken.Trim();

        // Careful: Volatile. The token is set on the tray/enroll thread and read on the sync
        // thread. With a plain assignment the JIT's caching could keep the old value around
        // indefinitely, so 401s would continue even after enroll.
        Volatile.Write(ref _token, normalized);
    }

    /// <summary>
    /// Certificate pinning.
    ///
    /// Careful: <b>installing this callback turns off all of .NET's own validation</b>:
    /// hostname matching, the chain, expiry, everything. Whatever the callback says is final.
    /// So writing <c>return true</c> as soon as the pin matches is the easiest mistake, and
    /// hostname and expiry checks would silently disappear.
    ///
    /// So the decision is not here but in <see cref="CertificatePin"/>, where the
    /// <c>sslErrors == None</c> condition is also checked, and the whole thing can be covered
    /// in a unit test without any TLS.
    ///
    /// Careful: with no pin, <c>null</c> is returned: the callback is not installed at all and
    /// .NET runs its normal validation. The only safe way to avoid the wrong default of "no
    /// pin means skip validation" is to **not install** the callback.
    /// </summary>
    private static SslClientAuthenticationOptions? BuildSslOptions(
        IReadOnlyList<string> pins, ISyncLog log)
    {
        if (pins.Count == 0)
        {
            // Careful: we must not stay silent. Setting the pin is part of the production
            // checklist, and if it is not set the admin should be able to learn that from the log.
            log.Warn(
                "No SERVERPIN configured — the agent trusts whatever certificate Windows accepts. " +
                "On a self-signed office certificate that is weaker than it sounds (deploy/README.md › \"Certificate pinning on the agent\").");
            return null;
        }

        log.Info($"Certificate pinning is on ({pins.Count} pin(s))");

        return new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, cert, _, sslErrors) =>
            {
                var presented = cert is null ? null : SpkiHash(cert);
                var verdict = CertificatePin.Check(
                    pins, presented, chainOk: sslErrors == SslPolicyErrors.None);

                if (verdict == CertificatePin.Verdict.Trusted) return true;

                // Careful: the reason for rejection goes in the log, but **not the pin value**.
                // It is not secret, but there is still no reason to fill the log with it.
                log.Error("TLS: " + CertificatePin.Explain(verdict));
                return false;
            },
        };
    }

    /// <summary>
    /// The sha256 of the certificate's <b>public key</b>, base64.
    ///
    /// Important: the hash of the SPKI, not of the whole certificate, because at renewal a new
    /// certificate is usually issued on the same key. Pinning the certificate hash would mean
    /// distributing a new pin to 15 PCs at every renewal
    /// (`make-cert.ps1` prints this same value too).
    /// </summary>
    private static string? SpkiHash(X509Certificate certificate)
    {
        try
        {
            using var cert = new X509Certificate2(certificate);
            return Convert.ToBase64String(
                SHA256.HashData(cert.PublicKey.ExportSubjectPublicKeyInfo()));
        }
        catch (CryptographicException)
        {
            // The certificate could not even be read; safest to assume it will not match
            return null;
        }
    }

    private string? ResolveToken() => Volatile.Read(ref _token) ?? _tokenSource?.CurrentToken;

    // ── enroll / config / heartbeat ─────────────────────────────────────────

    /// <summary>
    /// Just the HTTP call. Careful: writing the token to disk, deriving the machineGuid,
    /// asking for the enrollment code: none of that is here, that is the secrets module's
    /// job. This class knows the token only as a string.
    /// </summary>
    public Task<SyncResult<EnrollResponse>> EnrollAsync(
        EnrollRequest request, CancellationToken ct = default)
    {
        // Careful: no ArgumentNullException is thrown on null. The contract of this interface
        // is "never throws"; the caller has no try/catch anywhere, and one escaped exception
        // would quietly kill the sync worker.
        if (request is null) return Task.FromResult(SyncResult<EnrollResponse>.Permanent(null, "enroll: no request"));

        var message = NewJsonRequest(HttpMethod.Post, "agent/enroll", SyncWire.Enroll(request), anonymous: true);

        return ExecuteAsync<EnrollResponse>(
            message, _options.ControlTimeout, gate: null, what: "enroll",
            onSuccess: (_, body) =>
            {
                var value = SyncJson.TryDeserialize<EnrollResponse>(body);
                if (value is not null) return SyncResult<EnrollResponse>.Ok(value);

                // Careful: this is the worst outcome: the server has created the device and
                // sends the token only once, and if we could not read it the token is gone.
                // The only fix is a new enrollment code. So log loudly.
                _log.Error("enroll: the server returned 2xx but the response could not be read — " +
                           "the deviceToken is lost, a new enrolment code is needed");
                return SyncResult<EnrollResponse>.Permanent(200, "enroll: could not read the response JSON");
            },
            ct);
    }

    /// <summary>
    /// Enrollment using the staff member's own login.
    ///
    /// Careful: <c>anonymous: true</c>. There is no device token here, that is exactly what
    /// we are going to fetch. Without it some earlier token (even after a revoke) would go
    /// into the header and the server would answer 401.
    ///
    /// Careful: even on failure <b>the request object is not logged</b>; it contains the
    /// password.
    /// </summary>
    public Task<SyncResult<EnrollLoginResponse>> EnrollWithLoginAsync(
        EnrollLoginRequest request, CancellationToken ct = default)
    {
        if (request is null)
            return Task.FromResult(SyncResult<EnrollLoginResponse>.Permanent(null, "enroll-login: no request"));

        var message = NewJsonRequest(
            HttpMethod.Post, "agent/enroll-login", SyncWire.EnrollLogin(request), anonymous: true);

        return ExecuteAsync<EnrollLoginResponse>(
            message, _options.ControlTimeout, gate: null, what: "enroll-login",
            onSuccess: (_, body) =>
            {
                var value = SyncJson.TryDeserialize<EnrollLoginResponse>(body);
                if (value is not null) return SyncResult<EnrollLoginResponse>.Ok(value);

                // Careful: the same worst outcome as with enroll: the server has created the
                // device and sends the token only once. Not being able to read it means the
                // token is gone.
                _log.Error("enroll-login: the server returned 2xx but the response could not be read — " +
                           "the deviceToken is lost, sign in again");
                return SyncResult<EnrollLoginResponse>.Permanent(200, "enroll-login: could not read the response JSON");
            },
            ct);
    }

    public Task<SyncResult<ConfigResponse>> GetConfigAsync(CancellationToken ct = default)
    {
        var message = NewJsonRequest(HttpMethod.Get, "agent/config");

        return ExecuteAsync<ConfigResponse>(
            message, _options.ControlTimeout, gate: null, what: "config",
            onSuccess: (_, body) =>
            {
                var value = SyncJson.TryDeserialize<ConfigResponse>(body);

                // If no config arrives, tracking does not stop; the caller carries on with the
                // old/default config (see the comment on AgentConfig.Default).
                return value is not null
                    ? SyncResult<ConfigResponse>.Ok(value)
                    : SyncResult<ConfigResponse>.Transient(200, "config: could not read the response JSON");
            },
            ct);
    }

    public Task<SyncResult<HeartbeatResponse>> HeartbeatAsync(
        HeartbeatRequest request, CancellationToken ct = default)
    {
        if (request is null)
            return Task.FromResult(SyncResult<HeartbeatResponse>.Transient(null, "heartbeat: no request"));

        var message = NewJsonRequest(HttpMethod.Post, "agent/heartbeat", SyncWire.Heartbeat(request));

        return ExecuteAsync<HeartbeatResponse>(
            message, _options.ControlTimeout, gate: null, what: "heartbeat",
            onSuccess: (_, body) =>
            {
                var dto = SyncJson.TryDeserialize<SyncWire.HeartbeatResponseDto>(body);
                return dto is not null
                    ? SyncResult<HeartbeatResponse>.Ok(SyncWire.ToHeartbeatResponse(dto))
                    : SyncResult<HeartbeatResponse>.Transient(200, "heartbeat: could not read the response JSON");
            },
            ct);
    }

    // ── ingest ──────────────────────────────────────────────────────────────

    // Careful: a null list is treated as an empty list (no throw). There was nothing to send,
    // so it is a "success"; the caller's queue had nothing in it.
    public Task<SyncResult<IngestAck>> SendSegmentsAsync(
        IReadOnlyList<ActivitySegment> segments, CancellationToken ct = default) =>
        IngestAsync("agent/segments", "segments", segments?.Count ?? 0,
            () => SyncWire.Segments(segments!), ct);

    public Task<SyncResult<IngestAck>> SendAppUsageAsync(
        IReadOnlyList<AppUsageRecord> items, CancellationToken ct = default) =>
        IngestAsync("agent/app-usage", "app-usage", items?.Count ?? 0,
            () => SyncWire.AppUsage(items!), ct);

    public Task<SyncResult<IngestAck>> SendEventsAsync(
        IReadOnlyList<AgentEventRecord> events, CancellationToken ct = default) =>
        IngestAsync("agent/events", "events", events?.Count ?? 0,
            () => SyncWire.Events(events!), ct);

    /// <summary>The same body for the three ingest endpoints; only the path and wrapper differ.</summary>
    private Task<SyncResult<IngestAck>> IngestAsync<TPayload>(
        string path, string what, int count, Func<TPayload> payload, CancellationToken ct)
    {
        // No point going to the network with an empty batch; it would only waste one
        // rate-limit permit, which is the precious thing while draining a backlog.
        if (count == 0) return Task.FromResult(SyncResult<IngestAck>.Ok(EmptyAck));

        if (count > SyncLimits.MaxBatchSize)
        {
            // Careful: this is a caller bug (splitting is the caller's job, see ISyncClient).
            // Returning Permanent would be the proper punishment, but then someone's paid hours
            // would pay for a programming mistake. So the data is kept:
            // Transient + a loud log. The queue stays stuck, the tray turns red, someone sees it.
            _log.Error($"{what}: {count} records in the batch — the limit is {SyncLimits.MaxBatchSize}. " +
                       "The caller did not split it; nothing was sent, the data stays in the queue");
            return Task.FromResult(SyncResult<IngestAck>.Transient(
                null, $"{what}: batch too large ({count} > {SyncLimits.MaxBatchSize}) — the caller must split it"));
        }

        var message = NewJsonRequest(HttpMethod.Post, path, payload());

        return ExecuteAsync<IngestAck>(
            message, _options.IngestTimeout, _ingestGate, what,
            onSuccess: (_, body) =>
            {
                // A 2xx means the server has taken the data. Not being able to read the response
                // JSON (a proxy's truncated body, a new future shape) does not change that.
                // Treating it as a failure would send the batch again; the server would drop it
                // as a duplicate, but the queue would never empty.
                var ack = SyncJson.TryDeserialize<IngestAck>(body)
                          ?? new IngestAck { Accepted = count, Duplicates = 0, Split = 0 };

                return SyncResult<IngestAck>.Ok(ack);
            },
            ct);
    }

    // ── screenshot ──────────────────────────────────────────────────────────

    public async Task<SyncResult<ScreenshotAck>> SendScreenshotAsync(
        ScreenshotRecord meta, string webpPath, CancellationToken ct = default)
    {
        if (meta is null)
            return SyncResult<ScreenshotAck>.Permanent(null, "screenshot: no meta");

        // ── checks before going to the network ────────────────────────────
        // Careful: returning Permanent here is a deliberate exception: the file is missing or
        // too large, so a thousand tries give the same result. Saying Transient would leave
        // that row at the head of the queue forever and block every image behind it.
        if (string.IsNullOrWhiteSpace(webpPath))
            return SyncResult<ScreenshotAck>.Permanent(null, "screenshot: the file path is empty");

        long length;
        try
        {
            var info = new FileInfo(webpPath);
            if (!info.Exists)
            {
                _log.Error($"screenshot: file missing — {webpPath} (the row will be dropped)");
                return SyncResult<ScreenshotAck>.Permanent(null, $"screenshot: file missing — {webpPath}");
            }

            length = info.Length;
        }
        catch (Exception e) when (
            e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // The path could not even be read; retrying will not fix this either
            _log.Error($"screenshot: could not stat the file — {webpPath}", e);
            return SyncResult<ScreenshotAck>.Permanent(null, $"screenshot: could not stat the file — {e.Message}");
        }

        if (length == 0)
            return SyncResult<ScreenshotAck>.Permanent(null, "screenshot: the file is 0 bytes");

        if (length > SyncLimits.MaxScreenshotBytes)
        {
            _log.Error($"screenshot: {length / 1024} KB > the limit of " +
                       $"{SyncLimits.MaxScreenshotBytes / 1024} KB — it was not sent at all");
            return SyncResult<ScreenshotAck>.Permanent(
                413, $"screenshot: {length} bytes, the limit is {SyncLimits.MaxScreenshotBytes}");
        }

        HttpRequestMessage message;
        try
        {
            message = BuildScreenshotRequest(meta, webpPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // The FileStream could not be opened (deleted, locked by another process).
            // A lock can be temporary, so this is Transient, unlike a file that does not exist.
            _log.Warn($"screenshot: could not open the file — {webpPath}: {e.Message}");
            return SyncResult<ScreenshotAck>.Transient(null, $"screenshot: could not open the file — {e.Message}");
        }

        return await ExecuteAsync<ScreenshotAck>(
            message, _options.ScreenshotTimeout, _screenshotGate, "screenshot",
            onSuccess: (_, body) =>
            {
                var ack = SyncJson.TryDeserialize<ScreenshotAck>(body)
                          ?? new ScreenshotAck { Accepted = true, Duplicate = false };

                return SyncResult<ScreenshotAck>.Ok(ack);
            },
            ct).ConfigureAwait(false);
    }

    /// <summary>
    /// multipart/form-data: two parts, and the server checks the shape of both strictly.
    /// </summary>
    private static HttpRequestMessage BuildScreenshotRequest(ScreenshotRecord meta, string webpPath)
    {
        // Careful: by default .NET wraps the boundary in quotes (boundary="…"). Most parsers
        // accept that, but some strict ones do not, and then a 400 "no file found" comes back
        // even though the request looks perfect. So the boundary is set by hand, without
        // quotes, using only safe characters.
        var boundary = $"oXeio{Guid.NewGuid():N}";
        var content = new MultipartFormDataContent(boundary);
        var mediaType = content.Headers.ContentType!;
        mediaType.Parameters.Clear();
        mediaType.Parameters.Add(new NameValueHeaderValue("boundary", boundary));

        // ── meta: a JSON *string*, not a JSON object ─────────────────────
        // The server reads this field as a plain form field and then runs JSON.parse itself.
        // If sent with Content-Type: application/json, the multipart parser treats it as a
        // separate part and the field becomes "missing", with the result: a silent 400 on
        // every screenshot, forever.
        // A browser's FormData.append(name, string) sends exactly this way:
        // with no Content-Type header.
        var metaJson = SyncJson.Serialize(SyncWire.ScreenshotMeta(meta));
        var metaPart = new StringContent(metaJson, Encoding.UTF8);
        metaPart.Headers.ContentType = null;
        content.Add(metaPart, "meta");

        // ── file ─────────────────────────────────────────────────────────
        // Careful: useAsync: true, otherwise every read would block a thread synchronously.
        // The whole file is not loaded into memory; StreamContent streams it directly.
        var stream = new FileStream(
            webpPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 64 * 1024, useAsync: true);

        var filePart = new StreamContent(stream);
        filePart.Headers.ContentType = new MediaTypeHeaderValue(SyncLimits.ScreenshotMimeType);

        // Careful: without a filename multer treats this as a text field, not a file. The name
        // is ASCII on purpose (uuid): if the real disk name had non-ASCII characters, .NET
        // would send the RFC 5987 filename*= form, which not every parser understands.
        content.Add(filePart, "file", $"{meta.ClientUuid:N}.webp");

        // ── thumb (A06), optional ────────────────────────────────────────
        // Careful: without it the request is still valid; the server keeps `thumb_path` null
        // and the gallery falls back to the full image. A missing thumbnail must not leave an
        // image stuck or dropped.
        var thumbPath = OutboxPaths.ThumbPathFor(webpPath);
        if (File.Exists(thumbPath))
        {
            var thumbStream = new FileStream(
                thumbPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 16 * 1024, useAsync: true);

            var thumbPart = new StreamContent(thumbStream);
            thumbPart.Headers.ContentType = new MediaTypeHeaderValue(SyncLimits.ScreenshotMimeType);
            content.Add(thumbPart, "thumb", $"{meta.ClientUuid:N}-thumb.webp");
        }

        return new HttpRequestMessage(HttpMethod.Post, "agent/screenshots") { Content = content };
    }

    // ── update ──────────────────────────────────────────────────────────────

    public Task<SyncResult<UpdateOffer>> CheckUpdateAsync(
        string currentVersion, CancellationToken ct = default)
    {
        var path = $"agent/update?current={Uri.EscapeDataString(currentVersion ?? string.Empty)}";
        var message = NewJsonRequest(HttpMethod.Get, path);

        return ExecuteAsync<UpdateOffer>(
            message, _options.ControlTimeout, gate: null, what: "update-check",
            onSuccess: (response, body) =>
            {
                // 204 = already up to date. Success, but Value is null (by contract).
                if (response.StatusCode == HttpStatusCode.NoContent || string.IsNullOrWhiteSpace(body))
                    return SyncResult<UpdateOffer>.Ok(null, (int)response.StatusCode);

                var offer = SyncJson.TryDeserialize<UpdateOffer>(body);
                return offer is not null
                    ? SyncResult<UpdateOffer>.Ok(offer, (int)response.StatusCode)
                    : SyncResult<UpdateOffer>.Transient(200, "update-check: could not read the response JSON");
            },
            ct);
    }

    public async Task<SyncResult<UpdateDownload>> DownloadUpdateAsync(
        string version, string destinationPath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(destinationPath))
            return SyncResult<UpdateDownload>.Permanent(null, "update-download: the destination path is empty");

        // Careful: not written directly to the destination. If a half-downloaded MSI sat under
        // the destination name, someone might later take it for complete and run it. It is
        // written to .part, the hash is checked, and then it is renamed; the rename is atomic.
        var partPath = destinationPath + ".part";

        using var message = new HttpRequestMessage(
            HttpMethod.Get, $"agent/update/download?version={Uri.EscapeDataString(version ?? string.Empty)}");

        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_options.DownloadTimeout);

            using var response = await _http
                .SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cts.Token)
                .ConfigureAwait(false);

            var status = (int)response.StatusCode;
            if (status is < 200 or > 299)
            {
                var body = await ReadBodyAsync(response, cts.Token).ConfigureAwait(false);
                return Classify<UpdateDownload>(status, body, response, "update-download");
            }

            long total = 0;
            using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

            await using (var source = await response.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false))
            await using (var target = new FileStream(
                partPath, FileMode.Create, FileAccess.Write, FileShare.None,
                bufferSize: 128 * 1024, useAsync: true))
            {
                var buffer = new byte[128 * 1024];
                int read;

                while ((read = await source.ReadAsync(buffer, cts.Token).ConfigureAwait(false)) > 0)
                {
                    total += read;

                    if (total > _options.MaxUpdateBytes)
                    {
                        _log.Error($"update-download: {total} bytes went past the limit of {_options.MaxUpdateBytes} — stopped");
                        return SyncResult<UpdateDownload>.Permanent(
                            status, $"update-download: the file is larger than the limit ({_options.MaxUpdateBytes} bytes)");
                    }

                    hasher.AppendData(buffer, 0, read);
                    await target.WriteAsync(buffer.AsMemory(0, read), cts.Token).ConfigureAwait(false);
                }

                await target.FlushAsync(cts.Token).ConfigureAwait(false);
            }

            if (total == 0)
                return SyncResult<UpdateDownload>.Transient(status, "update-download: 0 bytes arrived");

            var sha = Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant();
            File.Move(partPath, destinationPath, overwrite: true);

            _log.Info($"update-download: {total / 1024} KB downloaded → {destinationPath}");

            return SyncResult<UpdateDownload>.Ok(new UpdateDownload
            {
                SavedPath = destinationPath,
                Bytes = total,
                Sha256 = sha,
            });
        }
        catch (Exception e)
        {
            return MapException<UpdateDownload>(e, ct.IsCancellationRequested, "update-download");
        }
        finally
        {
            // On success .part is gone (it was Moved); on failure no garbage is left behind.
            TryDelete(partPath);
        }
    }

    // ── the common path ─────────────────────────────────────────────────────

    /// <summary>
    /// The whole life of one request: rate limit, timeout, send, classification.
    ///
    /// Careful: <paramref name="onSuccess"/> is called only on a 2xx, and it too must never
    /// throw (JSON is read with <see cref="SyncJson.TryDeserialize{T}"/>).
    /// </summary>
    private async Task<SyncResult<T>> ExecuteAsync<T>(
        HttpRequestMessage message,
        TimeSpan timeout,
        SlidingWindowGate? gate,
        string what,
        Func<HttpResponseMessage, string, SyncResult<T>> onSuccess,
        CancellationToken ct)
        where T : class
    {
        using (message)
        {
            try
            {
                // The wait on the gate is outside the timeout. Inside it, while draining a
                // backlog the request would be "timed out" and cancelled after a 40 second wait,
                // so obeying the rate limit would be punished as a failure.
                if (gate is not null) await gate.WaitAsync(ct).ConfigureAwait(false);

                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(timeout);

                using var response = await _http.SendAsync(message, cts.Token).ConfigureAwait(false);
                var body = await ReadBodyAsync(response, cts.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;

                return status is >= 200 and <= 299
                    ? onSuccess(response, body)
                    : Classify<T>(status, body, response, what);
            }
            catch (Exception e)
            {
                return MapException<T>(e, ct.IsCancellationRequested, what);
            }
        }
    }

    /// <summary>Status to result. Rules are in <see cref="SyncOutcomeClassifier"/>; here only wrapper and log.</summary>
    private SyncResult<T> Classify<T>(
        int status, string body, HttpResponseMessage response, string what)
        where T : class
    {
        var revoked = status == 403 && LooksRevoked(body);
        var outcome = SyncOutcomeClassifier.FromHttpStatus(status, revoked);
        var detail = $"{what}: HTTP {status} {response.ReasonPhrase} {Shorten(body)}".TrimEnd();

        switch (outcome)
        {
            case SyncOutcome.Revoked:
                _log.Error($"⛔ This device has been revoked — {detail}");
                return SyncResult<T>.Revoked(detail);

            case SyncOutcome.Permanent:
                // "Log loudly": this is the moment at which data is dropped for good.
                // The body is kept because the server's validation message is the only clue;
                // without it nobody would ever know which field was wrong.
                _log.Error($"❌ Permanent rejection, these records will be dropped — {detail}");
                return SyncResult<T>.Permanent(status, detail);

            default:
                var retryAfter = ReadRetryAfter(response);
                _log.Warn(retryAfter is { } wait
                    ? $"{detail} (Retry-After {wait.TotalSeconds:F0}s)"
                    : detail);

                return SyncResult<T>.Transient(status, detail, retryAfter);
        }
    }

    /// <summary>
    /// Exception to <see cref="SyncOutcome.Transient"/>. No exceptions to that rule:
    /// <see cref="SyncOutcomeClassifier.FromTransportFailure"/> is always Transient, because
    /// no response at all means the server has not said "no" yet.
    /// </summary>
    private SyncResult<T> MapException<T>(Exception e, bool callerCancelled, string what)
        where T : class
    {
        switch (e)
        {
            case OperationCanceledException when callerCancelled:
                // The agent is stopping; not an error, so no fuss in the log
                return SyncResult<T>.Transient(null, $"{what}: cancelled (the agent is stopping)");

            case OperationCanceledException:
                _log.Warn($"{what}: timeout");
                return SyncResult<T>.Transient(null, $"{what}: timeout");

            case HttpRequestException http:
            {
                int? status = null;
                if (http.StatusCode is { } code) status = (int)code;

                _log.Warn($"{what}: {http.HttpRequestError} — {Shorten(http.Message)}");
                return SyncResult<T>.Transient(status, $"{what}: {http.HttpRequestError}");
            }

            case IOException io:
                _log.Warn($"{what}: I/O — {Shorten(io.Message)}");
                return SyncResult<T>.Transient(null, $"{what}: I/O — {Shorten(io.Message)}");

            default:
                // Careful: unexpected. Still not thrown; one escaped exception would kill the
                // sync worker thread, and then data would never go out again.
                _log.Error($"{what}: unexpected error", e);
                return SyncResult<T>.Transient(null, $"{what}: {e.GetType().Name} — {Shorten(e.Message)}");
        }
    }

    private static HttpRequestMessage NewJsonRequest(HttpMethod method, string path) =>
        new(method, path);

    private static HttpRequestMessage NewJsonRequest<TPayload>(
        HttpMethod method, string path, TPayload payload, bool anonymous = false)
    {
        var message = new HttpRequestMessage(method, path)
        {
            // Careful: generic TPayload. Passed as object, STJ would serialize by the declared
            // type and send "{}" with nothing written. That means an empty body, an empty
            // body means a 400, and a 400 means the data is deleted.
            Content = new StringContent(SyncJson.Serialize(payload), Encoding.UTF8, "application/json"),
        };

        if (anonymous) message.Options.Set(SyncHeadersHandler.Anonymous, true);
        return message;
    }

    /// <summary>
    /// Reads the body, but only up to a limit. Careful: a wrong route or a captive portal can
    /// return 50 MB of HTML; loading all of it into memory is pointless GC pressure, and it
    /// would happen at the worst time (network trouble).
    /// </summary>
    private static async Task<string> ReadBodyAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);

            var buffer = new byte[16 * 1024];
            using var memory = new MemoryStream(capacity: 4 * 1024);

            while (memory.Length < MaxBodyBytes)
            {
                var room = (int)Math.Min(buffer.Length, MaxBodyBytes - memory.Length);
                var read = await stream.ReadAsync(buffer.AsMemory(0, room), ct).ConfigureAwait(false);
                if (read <= 0) break;

                memory.Write(buffer, 0, read);
            }

            return Encoding.UTF8.GetString(memory.GetBuffer(), 0, (int)memory.Length);
        }
        catch (Exception)
        {
            // Failing to read the body is never more important than the status code
            return string.Empty;
        }
    }

    /// <summary>
    /// Whether the body of a 403 contains <c>{ command: "revoke" }</c>.
    ///
    /// Careful: saying true by mistake shuts that machine's tracking down <b>permanently</b>.
    /// So we look for the specific shape, not just any occurrence of the word "revoke". The
    /// server may send the message inside a wrapper (<c>{ statusCode, message: { command } }</c>),
    /// so we look several levels deep.
    /// </summary>
    private static bool LooksRevoked(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return false;

        try
        {
            using var document = JsonDocument.Parse(body);
            return HasRevokeCommand(document.RootElement, depth: 0);
        }
        catch (JsonException)
        {
            // Not JSON at all (a proxy's HTML page?). Counted only if both words are present.
            return body.Contains("command", StringComparison.OrdinalIgnoreCase)
                   && body.Contains(AgentCommands.Revoke, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static bool HasRevokeCommand(JsonElement element, int depth)
    {
        if (depth > 6) return false;

        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    if (property.NameEquals("command")
                        && property.Value.ValueKind == JsonValueKind.String
                        && string.Equals(property.Value.GetString(), AgentCommands.Revoke,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }

                    if (HasRevokeCommand(property.Value, depth + 1)) return true;
                }

                return false;

            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    if (HasRevokeCommand(item, depth + 1)) return true;
                }

                return false;

            default:
                return false;
        }
    }

    /// <summary>
    /// <c>Retry-After</c>, in seconds or as a date.
    ///
    /// Careful: the date form has to be subtracted from our own clock, yet measuring this
    /// agent's clock error is itself one of the server's jobs (x-client-time). If the clock
    /// were a day behind, "come back in a day" would come out and the machine would stay
    /// silent for a day. So both forms are capped at <see cref="MaxRetryAfter"/>.
    /// </summary>
    private static TimeSpan? ReadRetryAfter(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        if (header is null) return null;

        TimeSpan wait;
        if (header.Delta is { } delta) wait = delta;
        else if (header.Date is { } date) wait = date - DateTimeOffset.UtcNow;
        else return null;

        if (wait < TimeSpan.Zero) return TimeSpan.Zero;

        return wait > MaxRetryAfter ? MaxRetryAfter : wait;
    }

    private static string Shorten(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        // The log needs to stay on one line, otherwise it is hard to find in the file
        var flat = text.Replace('\r', ' ').Replace('\n', ' ').Trim();

        return flat.Length <= MaxDetailChars ? flat : flat[..MaxDetailChars] + "…";
    }

    private static Uri EnsureTrailingSlash(Uri baseAddress)
    {
        var text = baseAddress.AbsoluteUri;
        return text.EndsWith('/') ? baseAddress : new Uri(text + "/", UriKind.Absolute);
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
            // Nothing that fails to delete breaks anything; the next download will overwrite it
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _http.Dispose();          // the inner handler chain is released here too
        _ingestGate.Dispose();
        _screenshotGate.Dispose();
    }
}
