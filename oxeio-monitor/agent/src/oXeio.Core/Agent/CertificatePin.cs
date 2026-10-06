namespace oXeio.Core.Agent;

/// <summary>
/// **I01**: the decision part of pinning the server's certificate.
///
/// <b>No X509, no TLS, no Win32 here</b>, only "do we accept what we were given". This
/// decision is the one place where a mistake makes security vanish <b>silently</b>, and if it
/// sat inside the TLS handler, testing it would need a real certificate, a real MITM and a
/// test server.
/// </summary>
public static class CertificatePin
{
    public enum Verdict
    {
        /// <summary>No pin is set: .NET's own validation is the only safeguard.</summary>
        NoPinConfigured,

        /// <summary>The pin matched and the chain is clean.</summary>
        Trusted,

        /// <summary>
        /// A pin is set but <b>did not match</b>: someone else is on the other end of the wire.
        /// This is the whole purpose of pinning.
        /// </summary>
        PinMismatch,

        /// <summary>
        /// The pin matched, but .NET's own validation failed (hostname mismatch, expired,
        /// broken chain). <b>This is also a rejection</b>; see the doc below.
        /// </summary>
        ChainInvalid,

        /// <summary>No certificate arrived: the TLS handshake did not complete properly.</summary>
        NoCertificate,
    }

    /// <summary>
    /// <b>The most important line in this function is the `chainOk` check.</b>
    ///
    /// In .NET, installing a <c>RemoteCertificateValidationCallback</c> means <b>all of its own
    /// validation is switched off</b>: hostname matching, chain, expiry, everything. Whatever
    /// the callback says is final. So writing <c>return true</c> as soon as the pin matches is
    /// the easiest mistake, and hostname validation and expiry would both silently go away.
    ///
    /// So <b>both</b> are required here: the pin must match <b>and</b> the list of objections
    /// .NET raised must be empty.
    ///
    /// Multiple pins are allowed on purpose: on certificate renewal day both the old and the
    /// new one must stay valid for a while, otherwise at the moment of renewal 15 agents would
    /// lose their connection at once (runbook section 7.1).
    /// </summary>
    /// <param name="pins">
    /// Read from the registry, comma-separated base64 SPKI hashes. If empty,
    /// <see cref="Verdict.NoPinConfigured"/>.
    /// </param>
    /// <param name="presentedSpkiHash">
    /// sha256 of the SPKI of the certificate presented on the wire, base64. Null = no certificate came.
    /// </param>
    /// <param name="chainOk">Whether .NET's own validation was clean.</param>
    public static Verdict Check(
        IReadOnlyCollection<string> pins,
        string? presentedSpkiHash,
        bool chainOk)
    {
        if (pins.Count == 0) return Verdict.NoPinConfigured;
        if (string.IsNullOrWhiteSpace(presentedSpkiHash)) return Verdict.NoCertificate;

        // The order is deliberate: **pin first**, then chain. The other way round, getting an
        // expired certificate from a wrong server would log "expired", when the real news is
        // much bigger: it is not our server at all.
        var matched = false;
        foreach (var pin in pins)
        {
            if (string.Equals(pin, presentedSpkiHash, StringComparison.Ordinal))
            {
                matched = true;
                break;
            }
        }

        if (!matched) return Verdict.PinMismatch;

        return chainOk ? Verdict.Trusted : Verdict.ChainInvalid;
    }

    /// <summary>
    /// Config string → list of pins.
    ///
    /// Whitespace and empty parts are filtered out: values typed by hand into the registry
    /// often look like <c>"a=, b="</c> or end with a comma, and an empty string would then
    /// become a pin. It would never match anything, but would make the list "non-empty".
    /// </summary>
    public static IReadOnlyList<string> Parse(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured)) return [];

        var parts = configured.Split(',', StringSplitOptions.RemoveEmptyEntries);
        var pins = new List<string>(parts.Length);

        foreach (var part in parts)
        {
            var trimmed = part.Trim();
            if (trimmed.Length > 0) pins.Add(trimmed);
        }

        return pins;
    }

    /// <summary>
    /// A human-readable reason: goes to the tray tooltip and the log.
    ///
    /// The messages say <b>what to do</b>, not only what is wrong. On install day the admin
    /// reads just this one line.
    /// </summary>
    public static string Explain(Verdict verdict) => verdict switch
    {
        Verdict.Trusted => "The server certificate matches the pin.",

        Verdict.PinMismatch =>
            "The server's certificate does not match SERVERPIN. Either the certificate was " +
            "replaced (add the new pin before swapping it) or something is intercepting the " +
            "connection. No data is sent until this matches.",

        Verdict.ChainInvalid =>
            "The pin matches but the certificate itself is not valid — wrong hostname, expired, " +
            "or the chain is broken. Check the certificate's SAN list and expiry date.",

        Verdict.NoCertificate =>
            "The server presented no certificate. Is SERVERURL pointing at an https:// address?",

        _ => "No certificate pin is configured, so only the operating system's own checks apply.",
    };
}
