namespace oXeio.Agent.Sync;

/// <summary>
/// A narrow seam for the sync client's logging.
///
/// When a full logging module arrives, just wrap it in this interface. We did not pull in
/// <c>Microsoft.Extensions.Logging</c> here: no new NuGet packages (house rule), and this
/// module needs only three methods.
///
/// Careful: implementations must <b>never throw</b>. If writing a log line threw (disk full,
/// file locked) it would kill the sync worker, turning a logging problem into a data-loss
/// problem.
/// </summary>
internal interface ISyncLog
{
    void Info(string message);

    /// <summary>Transient noise: no network, 500, timeout. Everyday events.</summary>
    void Warn(string message);

    /// <summary>
    /// Anything someone needs to notice: permanent rejection (400/422), revoke, or an
    /// unexpected exception.
    /// </summary>
    void Error(string message, Exception? error = null);
}

/// <summary>Does nothing. Used when no logger is given, so null checks do not spread.</summary>
internal sealed class NullSyncLog : ISyncLog
{
    public static readonly NullSyncLog Instance = new();

    private NullSyncLog() { }

    public void Info(string message) { }
    public void Warn(string message) { }
    public void Error(string message, Exception? error = null) { }
}

/*
 * Careful: this used to hold `ConsoleSyncLog`, the <b>only</b> implementation, and
 * `Program.cs` installed it in the agent. But the project is `WinExe`, so there is
 * **no console**; every line went nowhere. The real implementation is therefore
 * `Storage/FileLog.cs`, which writes to disk with a 7 day / 50 MB limit.
 *
 * The class was removed rather than kept, because if kept someone would one day
 * install it again and the log would go nowhere again, with no error message.
 */
