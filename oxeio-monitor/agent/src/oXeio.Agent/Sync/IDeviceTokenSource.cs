namespace oXeio.Agent.Sync;

/// <summary>
/// Where the token comes from; this is all the sync client knows.
///
/// Careful: no disk reads, no DPAPI, no file paths here. The secrets module owns token
/// storage; the sync client just says "give me the current token". If two places read the
/// token in two different ways, on the day of a rotation one would keep using the old one
/// and every upload would get a 401, and since 401 is Transient nobody would notice.
/// </summary>
internal interface IDeviceTokenSource
{
    /// <summary>
    /// The current device token, or null (then every call except enroll gets a 401).
    ///
    /// Careful: this is called on every request, so it must be cheap: no disk reads or DPAPI
    /// decrypts inside, return a cached value. It must be thread-safe; the sync loop and the
    /// tray can call it at the same time.
    /// </summary>
    string? CurrentToken { get; }
}

/// <summary>
/// A simple source that does the job until the secrets module arrives (and in tests).
/// </summary>
internal sealed class InMemoryDeviceTokenSource : IDeviceTokenSource
{
    private string? _token;

    public InMemoryDeviceTokenSource(string? token = null) => _token = Normalize(token);

    public string? CurrentToken => Volatile.Read(ref _token);

    public void Set(string? token) => Volatile.Write(ref _token, Normalize(token));

    /// <summary>An empty string and null are the same thing; otherwise a <c>Bearer </c> header would go out.</summary>
    private static string? Normalize(string? token) =>
        string.IsNullOrWhiteSpace(token) ? null : token.Trim();
}
