namespace oXeio.Core.Apps;

/// <summary>
/// Only the domain from a URL, and recognizing private browsing ([ADR-013](../../../../docs/05-Options-Decisions.md)).
///
/// <b>A full URL is never stored anywhere</b>, neither on disk nor over the network.
/// <c>youtube.com</c> shows where the time went; <c>/watch?v=…</c> shows exactly what was
/// watched. This system has no need to know the second, and once stored it cannot be taken back.
/// </summary>
public static class DomainParser
{
    private static readonly char[] PathStarters = ['/', '?', '#'];

    /// <summary>
    /// Markers of a browser's private mode, as seen in the window title.
    ///
    /// This is not exact and cannot be; the wording changes between browser versions. So the
    /// error is kept on the <b>safe side</b>: when in doubt, nothing is recorded. Erring the
    /// other way would store someone's private browsing on the server, and it could not be
    /// taken back.
    /// </summary>
    private static readonly string[] PrivateMarkers =
    [
        "incognito",        // Chrome (en)
        "inprivate",        // Edge
        "private browsing", // Firefox
        "private window",   // Safari-style
        "ছদ্মবেশী",          // Chrome (bn)
    ];

    /// <summary>
    /// Whether this is a private browsing window, judged from the title.
    /// If true, <b>neither title nor domain</b> is recorded; only the fact that
    /// "a browser was used" remains.
    /// </summary>
    public static bool LooksPrivate(string? windowTitle)
    {
        if (string.IsNullOrWhiteSpace(windowTitle)) return false;

        var lower = windowTitle.ToLowerInvariant();
        foreach (var marker in PrivateMarkers)
        {
            if (lower.Contains(marker, StringComparison.Ordinal)) return true;
        }

        return false;
    }

    /// <summary>
    /// A URL, host, or anything typed in the address bar → the domain only.
    /// <c>null</c> if it cannot be understood: better to keep nothing than to guess.
    /// </summary>
    public static string? Extract(string? urlOrHost)
    {
        if (string.IsNullOrWhiteSpace(urlOrHost)) return null;

        var value = urlOrHost.Trim();

        // Strip the scheme: "https://", "http://", even "chrome://"
        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0) value = value[(scheme + 3)..];

        // The path/query/fragment are cut here. This one line keeps "/account/12345?token=…"
        // from ever reaching the database.
        var path = value.IndexOfAny(PathStarters);
        if (path >= 0) value = value[..path];

        // user:pass@host: a credential must never go out in any way
        var at = value.LastIndexOf('@');
        if (at >= 0) value = value[(at + 1)..];

        // Strip the port. IPv6 ([::1]:8080) is not handled by hand: with more than one ':' it
        // is left alone, or the address itself would be cut.
        var colon = value.LastIndexOf(':');
        if (colon > 0 && value.IndexOf(':') == colon) value = value[..colon];

        value = value.Trim().TrimEnd('.').ToLowerInvariant();

        return IsPlausibleHost(value) ? value : null;
    }

    /// <summary>
    /// People type anything into the address bar: search words, sentences in any language, file
    /// paths. Stored as a "domain" they would fill the report with garbage, and <b>the words
    /// searched for would go to the server</b>, which is effectively keylogging.
    /// So anything that does not look like a domain is dropped.
    /// </summary>
    private static bool IsPlausibleHost(string value)
    {
        if (value.Length is 0 or > 253) return false;
        if (value.Contains(' ', StringComparison.Ordinal)) return false;

        // Apart from localhost or IPv6, there must be a dot
        if (value is "localhost") return true;
        if (value.StartsWith('[') && value.EndsWith(']')) return true;

        var dot = value.IndexOf('.', StringComparison.Ordinal);
        if (dot <= 0 || dot == value.Length - 1) return false;

        foreach (var c in value)
        {
            var ok = char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_';
            if (!ok) return false;
        }

        return true;
    }
}
