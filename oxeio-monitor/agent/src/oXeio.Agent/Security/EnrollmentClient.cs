using System.Runtime.Versioning;

using oXeio.Core.Agent;

namespace oXeio.Agent.Security;

/// <summary>Exactly the ways an enroll attempt can end.</summary>
internal enum EnrollmentStatus
{
    /// <summary>Already done: the server was never contacted.</summary>
    AlreadyEnrolled,

    /// <summary>Success, and the token has been written to disk.</summary>
    Enrolled,

    /// <summary>
    /// The server did not accept the code: already used, expired, or wrong. Careful: retrying with
    /// the same code is pointless; a new code is needed.
    /// </summary>
    CodeRejected,

    /// <summary>
    /// The server was not found or returned 5xx/429. <b>Not fatal</b>: just try again later, with
    /// the same code.
    /// </summary>
    ServerUnreachable,

    /// <summary>Device revoked (H06). Not even an enroll attempt can be made any more.</summary>
    Revoked,

    /// <summary>A permanent machineGuid could not be created:
    /// <see cref="MachineIdentity.UsableForEnrollment"/>.</summary>
    IdentityUnusable,

    /// <summary>
    /// 2FA is on: cannot proceed without the six-digit code. Not a failure but the **second step**:
    /// the window then shows the code field.
    /// </summary>
    NeedsTotp,

    /// <summary>
    /// Careful: the account is not tied to any staff row (owner/manager), or it has been
    /// temporarily locked after repeated wrong passwords. In both cases trying again is no use: a
    /// person has to do something else, hence a separate status.
    /// </summary>
    SignInRejected,

    /// <summary>
    /// The server gave a token but it could not be written to disk. Careful: this is the worst
    /// outcome: the token comes only once, so it is gone for good and nothing can be done without a
    /// new enrollment code.
    /// </summary>
    StorageFailed,
}

/// <summary>
/// The enroll result. Careful: the token is deliberately <b>not</b> in here. The caller can safely
/// print it to the log.
/// </summary>
internal sealed record EnrollmentResult(
    EnrollmentStatus Status,
    string Message,
    int? DeviceId = null,
    string? EmpCode = null,
    int? HttpStatus = null)
{
    public bool Ok => Status is EnrollmentStatus.Enrolled or EnrollmentStatus.AlreadyEnrolled;

    /// <summary>Whether it makes sense to try again later with the same code.</summary>
    public bool Retryable => Status is EnrollmentStatus.ServerUnreachable;
}

/// <summary>
/// A one-time job: <c>POST /agent/enroll</c>, then the token to disk.
///
/// <b>Three failures that must be handled separately (or install day is ruined):</b>
///
/// 1. <b>The code was already used / expired:</b> the server gives 4xx, and
/// <see cref="SyncOutcomeClassifier"/> calls that Permanent. Retrying would only fill the rate
/// limit. The admin is told to ask for a new code.
///
/// 2. <b>The server cannot be reached at install time</b> (site line down, VPN not up): this is
/// <b>not fatal</b>. The installer will not fail, the agent starts, tracking keeps running on the
/// default config and data piles up in the outbox; when the line returns,
/// <see cref="EnrollWithRetryAsync"/> completes the enroll by itself. Careful: if install were
/// blocked here, setting up 15 PCs would wait for a router reboot, and nobody would get that day's
/// hours either.
///
/// 3. <b>The token came but could not be written to disk:</b>
///    <see cref="EnrollmentStatus.StorageFailed"/>. The token comes only once, so we must not stay
///    silent.
///
/// Careful: <b>log-leak trap:</b> <see cref="EnrollResponse"/> is a <c>record</c>, so its generated
/// <c>ToString</c> prints everything including <c>DeviceToken</c>. So in this class the response
/// object <b>never</b> goes to the log; the token is wrapped in <see cref="SecretText"/>
/// immediately and what goes outside is <see cref="EnrollmentResult"/>, which has no token.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class EnrollmentClient
{
    /// <summary>
    /// The enrollment code expires in 24 hours (H05), so retrying beyond that is pointless.
    /// </summary>
    public static readonly TimeSpan DefaultGiveUpAfter = TimeSpan.FromHours(24);

    /// <summary>
    /// A separate policy for enroll: starting from the outbox's 5 seconds, a dozen failed attempts
    /// in the first minute while the line is down would flood the log. Enroll is not urgent: start
    /// at 10 seconds, ceiling 5 minutes.
    /// </summary>
    private static readonly RetryPolicy Policy = new(
        baseDelay: TimeSpan.FromSeconds(10),
        multiplier: 2,
        maxDelay: TimeSpan.FromMinutes(5),
        jitterRatio: 0.25,
        maxAttempts: null,
        maxAge: TimeSpan.FromHours(24));

    private readonly ISyncClient _sync;
    private readonly DeviceTokenStore _store;
    private readonly DeviceCredentials _credentials;
    private readonly string? _agentVersion;
    private readonly Action<string>? _log;

    public EnrollmentClient(
        ISyncClient sync,
        DeviceTokenStore store,
        DeviceCredentials credentials,
        string? agentVersion = null,
        Action<string>? log = null)
    {
        _sync = sync;
        _store = store;
        _credentials = credentials;
        _agentVersion = agentVersion;
        _log = log;
    }

    /// <summary>
    /// One attempt. Careful: never throws: <see cref="ISyncClient"/> does not either, and disk
    /// failures are caught here.
    /// </summary>
    /// <param name="monitors">1-8. Outside that it is clamped, otherwise the server would give
    /// 400.</param>
    public async Task<EnrollmentResult> EnrollAsync(
        SecretText enrollmentCode, int? monitors = null, CancellationToken ct = default)
    {
        if (_credentials.IsRevoked)
            return new EnrollmentResult(EnrollmentStatus.Revoked, "This device has been revoked.");

        if (_credentials.IsEnrolled)
        {
            return new EnrollmentResult(
                EnrollmentStatus.AlreadyEnrolled,
                "Already enrolled — " + _credentials.Describe(),
                _credentials.DeviceId,
                _credentials.Employee?.EmpCode);
        }

        // Make sure **before going to the server** that the token can be kept. The code is
        // single-use: if enroll succeeded and the token came but the disk write failed, the code is
        // gone, the token is gone, and an orphan device is left on the server. This is exactly what
        // happened on a real machine.
        if (!_store.CanPersist(out var storageError))
        {
            return new EnrollmentResult(
                EnrollmentStatus.StorageFailed,
                $"The token store is not writable, so the enrolment code was not spent — {storageError}");
        }

        var identity = _credentials.Identity;
        if (!identity.UsableForEnrollment)
        {
            return new EnrollmentResult(
                EnrollmentStatus.IdentityUnusable,
                identity.Warning ?? "A stable machineGuid could not be created.");
        }

        if (enrollmentCode.IsBlank)
        {
            // No need to go to the network at all: the server would give 400 and the rate-limit
            // counter would rise for nothing.
            return new EnrollmentResult(EnrollmentStatus.CodeRejected, "The enrolment code is empty.");
        }

        var request = new EnrollRequest
        {
            EnrollmentCode = enrollmentCode.Reveal(),
            Hostname = identity.Hostname,
            WindowsUsername = identity.WindowsUsername,
            MachineGuid = identity.MachineGuid,
            OsVersion = identity.OsVersion,
            AgentVersion = _agentVersion,
            // Careful: clamp: if the server sees a value outside 1-8 the whole enroll gets 400, and
            // blocking enroll over a monitor-counting mistake is pointless.
            Monitors = monitors is { } count ? (int?)Math.Clamp(count, 1, 8) : null,
        };

        // Careful: the code does not go to the log: SecretText.ToString() prints only a
        // fingerprint.
        _log?.Invoke($"Enrolment attempt: code={enrollmentCode} · {identity.Describe()}");

        var response = await _sync.EnrollAsync(request, ct).ConfigureAwait(false);

        switch (response.Outcome)
        {
            case SyncOutcome.Success when response.Value is { } body:
                return Persist(body, identity);

            case SyncOutcome.Success:
                // 2xx but no body: usually a proxy in the middle. Not the record's fault, so it is
                // treated as retryable.
                return new EnrollmentResult(
                    EnrollmentStatus.ServerUnreachable,
                    "The server said success but the enrol body was empty (proxy?). It will be retried later.",
                    HttpStatus: response.StatusCode);

            case SyncOutcome.Revoked:
                _credentials.Revoke(response.Detail ?? "The server said revoked during enrolment");
                return new EnrollmentResult(
                    EnrollmentStatus.Revoked,
                    "This device has been revoked — " + (response.Detail ?? "reason unknown"),
                    HttpStatus: response.StatusCode);

            case SyncOutcome.Permanent:
                return new EnrollmentResult(
                    EnrollmentStatus.CodeRejected,
                    "The server did not accept the code (already used, invalid or expired): " +
                    (response.Detail ?? "reason unknown") +
                    ". Get a new enrolment code from the admin.",
                    HttpStatus: response.StatusCode);

            default:
                return new EnrollmentResult(
                    EnrollmentStatus.ServerUnreachable,
                    "Could not reach the server: " + (response.Detail ?? "reason unknown") +
                    ". The agent keeps running and will enrol by itself once the line is back.",
                    HttpStatus: response.StatusCode);
        }
    }

    /// <summary>
    /// <b>Staff add their own PC with their own email and password.</b>
    ///
    /// Careful: the password is in <see cref="SecretText"/>, so it cannot reach the log by mistake:
    /// the care taken with the enrollment code matters even more here.
    ///
    /// Careful: the password is <b>stored nowhere</b>. In this very call it is exchanged for a
    /// device token, and only the token goes to disk (via DPAPI).
    ///
    /// Careful: <see cref="EnrollmentStatus.SignInRejected"/> and
    /// <see cref="EnrollmentStatus.ServerUnreachable"/> are kept separate on purpose: for the first
    /// the person must do **something else** (the right account, or wait a few minutes), for the
    /// second just pressing again is enough.
    /// </summary>
    public async Task<EnrollmentResult> SignInAsync(
        string email,
        SecretText password,
        string? totp = null,
        int? monitors = null,
        CancellationToken ct = default)
    {
        if (_credentials.IsRevoked)
            return new EnrollmentResult(EnrollmentStatus.Revoked, "This device has been revoked.");

        if (_credentials.IsEnrolled)
        {
            return new EnrollmentResult(
                EnrollmentStatus.AlreadyEnrolled,
                "Already enrolled — " + _credentials.Describe(),
                _credentials.DeviceId,
                _credentials.Employee?.EmpCode);
        }

        // Make sure **before going to the server** that the token can be kept, because the token
        // comes only once (just like enroll).
        if (!_store.CanPersist(out var storageError))
        {
            return new EnrollmentResult(
                EnrollmentStatus.StorageFailed,
                $"The token store is not writable — {storageError}");
        }

        var identity = _credentials.Identity;
        if (!identity.UsableForEnrollment)
        {
            return new EnrollmentResult(
                EnrollmentStatus.IdentityUnusable,
                identity.Warning ?? "A stable machineGuid could not be created.");
        }

        if (string.IsNullOrWhiteSpace(email) || password.IsBlank)
        {
            // No need to go to the network: the server would give 400 and the throttle counter
            // would rise for nothing
            return new EnrollmentResult(
                EnrollmentStatus.SignInRejected, "Enter your email and password.");
        }

        var request = new EnrollLoginRequest
        {
            Email = email,
            Password = password.Reveal(),
            Totp = totp,
            Hostname = identity.Hostname,
            WindowsUsername = identity.WindowsUsername,
            MachineGuid = identity.MachineGuid,
            OsVersion = identity.OsVersion,
            AgentVersion = _agentVersion,
            Monitors = monitors is { } count ? (int?)Math.Clamp(count, 1, 8) : null,
        };

        // Careful: only the email goes to the log, not the password
        _log?.Invoke($"Sign-in attempt: {email} · {identity.Describe()}");

        var response = await _sync.EnrollWithLoginAsync(request, ct).ConfigureAwait(false);

        if (response.Outcome == SyncOutcome.Success)
        {
            if (response.Value is { NeedsTotp: true })
            {
                return new EnrollmentResult(
                    EnrollmentStatus.NeedsTotp,
                    "Enter the 6-digit code from your authenticator app.");
            }

            if (response.Value is { DeviceToken: not null } body)
            {
                return Persist(
                    new EnrollResponse
                    {
                        DeviceId = body.DeviceId ?? 0,
                        DeviceToken = body.DeviceToken,
                        Employee = body.Employee!,
                        ConfigVersion = body.ConfigVersion ?? string.Empty,
                        Config = body.Config!,
                    },
                    identity);
            }

            return new EnrollmentResult(
                EnrollmentStatus.ServerUnreachable,
                "The server said success but the response was empty (proxy?). Try again.",
                HttpStatus: response.StatusCode);
        }

        /**
         * Careful: here the work is **not** done by looking at <see cref="SyncOutcome"/>; the
         * status code itself must be looked at, and that is not a bug but the difference between
         * two contexts.
         *
         * `SyncOutcomeClassifier` was built for **data sync**, where 401 = "the token may be
         * refreshing, do not throw the queue away" and so Transient. In sign-in, 401 means exactly
         * the opposite and is completely certain: **wrong password**. Following that
         * classification, staff who typed a wrong password would read "cannot reach the server",
         * and call the network person and waste half an hour.
         *
         * For the same reason 429 here is not "later again" but "locked, please wait".
         */
        return response.StatusCode switch
        {
            401 => new EnrollmentResult(
                EnrollmentStatus.SignInRejected,
                "Email or password is incorrect.",
                HttpStatus: 401),

            // an owner/manager account: the server's message itself is what is useful
            403 => new EnrollmentResult(
                EnrollmentStatus.SignInRejected,
                response.Detail ?? "This account cannot be used on a staff PC.",
                HttpStatus: 403),

            429 => new EnrollmentResult(
                EnrollmentStatus.SignInRejected,
                "Too many failed attempts. Wait a few minutes and try again.",
                HttpStatus: 429),

            400 => new EnrollmentResult(
                EnrollmentStatus.SignInRejected,
                response.Detail ?? "The server did not accept this sign-in.",
                HttpStatus: 400),

            _ => new EnrollmentResult(
                EnrollmentStatus.ServerUnreachable,
                "Could not reach the server: " + (response.Detail ?? "reason unknown"),
                HttpStatus: response.StatusCode),
        };
    }

    /// <summary>
    /// If installed while there is no line, this is what keeps running in the background.
    ///
    /// Careful: <paramref name="giveUpAfter"/> is 24 hours, because the code's own lifetime is 24
    /// hours; trying beyond that only raises a storm of 4xx on the server. When it gives up,
    /// telling the admin by turning the tray red is the caller's job.
    /// </summary>
    public async Task<EnrollmentResult> EnrollWithRetryAsync(
        SecretText enrollmentCode,
        int? monitors = null,
        TimeSpan? giveUpAfter = null,
        CancellationToken ct = default)
    {
        var deadlineFrom = DateTimeOffset.UtcNow;
        var limit = giveUpAfter ?? DefaultGiveUpAfter;
        var attempt = 0;

        while (true)
        {
            var result = await EnrollAsync(enrollmentCode, monitors, ct).ConfigureAwait(false);
            if (!result.Retryable) return result;

            attempt++;

            var now = DateTimeOffset.UtcNow;
            if (now - deadlineFrom >= limit)
            {
                return result with
                {
                    Message = result.Message +
                              $" — {attempt} attempts over {limit.TotalHours:F0} hours and still no luck; " +
                              "the code has probably expired. Run again with a new code.",
                };
            }

            var delay = Policy.DelayFor(attempt, Random.Shared.NextDouble());
            _log?.Invoke($"Enrolment will be retried in {delay.TotalSeconds:F0}s (attempt {attempt})");

            try
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // the agent is shutting down. The last result is returned: this is not a failure.
                return result;
            }
        }
    }

    /// <summary>
    /// Order: disk first, then memory.
    /// If reversed, the agent would run even when the disk write failed, and after a reboot the
    /// token would be gone, by which time the server has forgotten the token (it keeps only a
    /// sha256).
    /// </summary>
    private EnrollmentResult Persist(EnrollResponse body, MachineIdentity identity)
    {
        var record = new DeviceCredentialRecord
        {
            DeviceId = body.DeviceId,
            Token = new SecretText(body.DeviceToken),
            MachineGuid = identity.MachineGuid,
            Hostname = identity.Hostname,
            EnrolledAt = DateTimeOffset.UtcNow,
            Employee = body.Employee,
            AgentVersion = _agentVersion,
        };

        var saved = _store.Save(record);
        if (!saved.Ok)
        {
            return new EnrollmentResult(
                EnrollmentStatus.StorageFailed,
                "❌ The server issued a token but it could not be written to disk: " + saved.Detail +
                ". The token is issued only once, so it cannot be recovered — " +
                $"fix the write permissions on {_store.FilePath} and run again with a new enrolment code.",
                body.DeviceId,
                body.Employee.EmpCode);
        }

        _credentials.Adopt(record);

        return new EnrollmentResult(
            EnrollmentStatus.Enrolled,
            $"Enrolment succeeded — device #{body.DeviceId}, {body.Employee.EmpCode} ({body.Employee.FullName})",
            body.DeviceId,
            body.Employee.EmpCode,
            201);
    }
}
