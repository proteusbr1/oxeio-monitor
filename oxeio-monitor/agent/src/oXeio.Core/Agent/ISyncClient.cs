using oXeio.Core.Models;

namespace oXeio.Core.Agent;

/// <summary>
/// The only door to the server: one endpoint, one method.
///
/// <b>Contract (implementations must honor all of these):</b>
/// <list type="number">
/// <item>No method <b>throws</b>. A network failure is a normal state here, not an
///       exception: see <see cref="SyncResult{T}"/>.</item>
/// <item>Every request carries the <see cref="SyncLimits.ClientTimeHeader"/> header, GETs
///       included. The server measures clock drift from it; without it the drift alert would
///       be wrong and nobody would notice.</item>
/// <item>All calls except <see cref="EnrollAsync"/> send <c>Authorization: Bearer</c>.</item>
/// <item>A 403 body containing <c>{ command: "revoke" }</c> must return
///       <see cref="SyncOutcome.Revoked"/>, not a retry.</item>
/// <item>Timeouts must be handled here. <c>HttpClient</c>'s default 100-second timeout is too
///       long: one hung connection blocks the whole sync loop for two minutes while the
///       queue keeps growing.</item>
/// </list>
///
/// The implementation must use <b>one</b> <c>HttpClient</c> for its whole lifetime. Creating a
/// new one per call leads to socket exhaustion within about a week, and the process will
/// certainly run for weeks on end.
/// </summary>
public interface ISyncClient
{
    /// <summary>
    /// Sets the token after enroll or after reading it from disk. Passing null clears it.
    /// Without a token every call except <see cref="EnrollAsync"/> gets a 401.
    /// </summary>
    void SetDeviceToken(string? deviceToken);

    Task<SyncResult<EnrollResponse>> EnrollAsync(
        EnrollRequest request, CancellationToken ct = default);

    /// <summary>
    /// Enroll using the staff member's own login. Careful: a 200 may not mean the work is done;
    /// see <see cref="EnrollLoginResponse.NeedsTotp"/>.
    /// </summary>
    Task<SyncResult<EnrollLoginResponse>> EnrollWithLoginAsync(
        EnrollLoginRequest request, CancellationToken ct = default);

    Task<SyncResult<ConfigResponse>> GetConfigAsync(CancellationToken ct = default);

    Task<SyncResult<HeartbeatResponse>> HeartbeatAsync(
        HeartbeatRequest request, CancellationToken ct = default);

    /// <summary>
    /// If <paramref name="segments"/> exceeds <see cref="SyncLimits.MaxBatchSize"/> the server
    /// returns 400 for the whole batch, so one oversized batch would turn five hundred rows
    /// into a "permanent rejection" and delete them. Splitting is the caller's job.
    /// </summary>
    Task<SyncResult<IngestAck>> SendSegmentsAsync(
        IReadOnlyList<ActivitySegment> segments, CancellationToken ct = default);

    /// <inheritdoc cref="SendSegmentsAsync"/>
    Task<SyncResult<IngestAck>> SendAppUsageAsync(
        IReadOnlyList<AppUsageRecord> items, CancellationToken ct = default);

    /// <inheritdoc cref="SendSegmentsAsync"/>
    Task<SyncResult<IngestAck>> SendEventsAsync(
        IReadOnlyList<AgentEventRecord> events, CancellationToken ct = default);

    /// <summary>
    /// One picture at a time: multipart, <c>meta</c> + <c>file</c>.
    ///
    /// <paramref name="webpPath"/> is a file on disk; the implementation must
    /// <b>stream</b> it and not load all of it into memory.
    ///
    /// If the file is missing or larger than <see cref="SyncLimits.MaxScreenshotBytes"/>, return
    /// <see cref="SyncOutcome.Permanent"/> without touching the network; otherwise a lost file
    /// would make that row retry forever and block the queue.
    /// </summary>
    Task<SyncResult<ScreenshotAck>> SendScreenshotAsync(
        ScreenshotRecord meta, string webpPath, CancellationToken ct = default);

    /// <summary>204 = up to date; then Success but <c>Value</c> is null.</summary>
    Task<SyncResult<UpdateOffer>> CheckUpdateAsync(
        string currentVersion, CancellationToken ct = default);

    /// <summary>Downloads the MSI to <paramref name="destinationPath"/> and computes its hash.</summary>
    Task<SyncResult<UpdateDownload>> DownloadUpdateAsync(
        string version, string destinationPath, CancellationToken ct = default);
}
