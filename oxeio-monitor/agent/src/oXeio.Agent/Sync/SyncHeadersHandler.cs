using System.Globalization;
using System.Net.Http.Headers;

using oXeio.Core.Agent;

namespace oXeio.Agent.Sync;

/// <summary>
/// Adds <c>x-client-time</c> and <c>Authorization</c> to every request.
///
/// <b>Why in a handler, not by hand in each method:</b> if you forget to add the header in
/// one of nine methods, it compiles, runs, and silently does the wrong thing; forgetting
/// it on the GETs is the most natural mistake. Adding it here leaves no way to forget.
/// </summary>
internal sealed class SyncHeadersHandler : DelegatingHandler
{
    /// <summary>
    /// Only <c>POST /agent/enroll</c> sends no token (there is no token yet).
    /// </summary>
    internal static readonly HttpRequestOptionsKey<bool> Anonymous = new("oXeio.sync.anonymous");

    private readonly Func<string?> _token;

    internal SyncHeadersHandler(Func<string?> tokenAccessor, HttpMessageHandler inner)
        : base(inner)
        => _token = tokenAccessor;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // Deliberately wall-clock (UtcNow), not monotonic. The server measures the device's
        // clock drift from this, so the thing being measured is the PC's wrong clock itself.
        // A monotonic clock would always show zero drift and a machine whose clock is ahead
        // or behind would never be caught.
        //
        // Careful: Remove first. On a redirect or retry the same message could go twice with
        // two headers, and the server would read the first one and compute a wrong drift.
        request.Headers.Remove(SyncLimits.ClientTimeHeader);
        request.Headers.TryAddWithoutValidation(
            SyncLimits.ClientTimeHeader,
            DateTimeOffset.UtcNow.ToString(SyncLimits.ClientTimeFormat, CultureInfo.InvariantCulture));

        var anonymous = request.Options.TryGetValue(Anonymous, out var flag) && flag;
        if (!anonymous && request.Headers.Authorization is null)
        {
            var token = _token();
            if (!string.IsNullOrEmpty(token))
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return base.SendAsync(request, cancellationToken);
    }
}
