namespace oXeio.Core.Agent;

/// <summary>
/// An upload attempt can end in exactly four ways. Collapse them into fewer and you either
/// lose data or retry forever.
/// </summary>
public enum SyncOutcome
{
    /// <summary>The server took it (even if it dropped it as a duplicate, it still "took" it). → ack</summary>
    Success,

    /// <summary>Trying again later will work: no network, 500, 429, timeout. → retry</summary>
    Transient,

    /// <summary>The server will never accept this record: 400/422/413. → abandon</summary>
    Permanent,

    /// <summary>
    /// This device was revoked (H06). Tracking must stop <b>permanently</b>, not retry. If it
    /// were confused with the other three, a revoked device would keep hitting the server forever.
    /// </summary>
    Revoked,
}

/// <summary>
/// HTTP status → <see cref="SyncOutcome"/>. Entirely pure, so it can be tested.
///
/// <b>Core principle:</b> when in doubt, <see cref="SyncOutcome.Transient"/>. The worst
/// result of a wrong retry is that the queue stays large for a while; wrongly saying
/// <see cref="SyncOutcome.Permanent"/> deletes someone's pay hours.
/// </summary>
public static class SyncOutcomeClassifier
{
    /// <param name="statusCode">The HTTP status. 0 or negative = no response came at all.</param>
    /// <param name="revokeCommandInBody">
    /// Whether the 403 body contained <c>{ "command": "revoke" }</c>. The server's
    /// <c>device-auth.guard.ts</c> sends exactly this.
    /// </param>
    public static SyncOutcome FromHttpStatus(int statusCode, bool revokeCommandInBody = false)
    {
        if (statusCode is >= 200 and <= 299) return SyncOutcome.Success;

        // 3xx is not handled by hand: HttpClient follows redirects itself. Arriving here means
        // redirects were off, i.e. a config error, not a record problem.
        if (statusCode is >= 300 and <= 399) return SyncOutcome.Transient;

        return statusCode switch
        {
            // 401 could be called Permanent ("bad token, the record will never go"), but then
            // a token refresh or a clock problem would delete the whole queue. The data is
            // kept; the tray turns red and tells the admin (J07).
            401 => SyncOutcome.Transient,

            403 => revokeCommandInBody ? SyncOutcome.Revoked : SyncOutcome.Transient,

            // A wrong base URL or a wrong reverse-proxy route: fixed once the admin corrects it.
            // Not the record's fault, so it must not be dropped.
            404 => SyncOutcome.Transient,

            408 or 425 or 429 => SyncOutcome.Transient,

            // 413: a .webp over 5 MiB; sending it again would give the same answer.
            413 => SyncOutcome.Permanent,

            _ when statusCode is >= 500 and <= 599 => SyncOutcome.Transient,

            // All other 4xx (400 validation, 415 wrong mime, 422 missing clientUuid):
            // the record itself is wrong, so retrying is pointless.
            _ when statusCode is >= 400 and <= 499 => SyncOutcome.Permanent,

            // 0 = could not connect; anything unknown gets the benefit of the doubt.
            _ => SyncOutcome.Transient,
        };
    }

    /// <summary>
    /// No response at all: DNS, TCP, TLS, timeout, LAN cable unplugged.
    /// The normal state of an office without internet, so always Transient.
    /// </summary>
    public static SyncOutcome FromTransportFailure() => SyncOutcome.Transient;
}
