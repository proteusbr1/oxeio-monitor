using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Watchdog;

namespace oXeio.Agent.Platform;

/// <summary>
/// The agent's side of a planned restart, on disk: the <c>agent.restart</c> marker for the
/// watchdog, the <c>agent.ceiling</c> stamp for its own loop guard, and the check that a watchdog
/// is there at all. The formats live in <see cref="PlannedRestartFiles"/> (Core), so the watchdog
/// reads exactly what is written here.
///
/// Careful: no method here throws. Each one is called on the way out of a process that is already
/// in trouble; an exception would turn a planned restart into a crash, which is the very thing
/// the marker exists to avoid.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class PlannedRestartStore
{
    private const int ErrorSharingViolation = 32;
    private const int ErrorLockViolation = 33;

    private readonly string _marker;
    private readonly string _stamp;
    private readonly string _watchdogLock;

    public PlannedRestartStore(string dataDirectory)
    {
        _marker = Path.Combine(dataDirectory, PlannedRestartFiles.MarkerFileName);
        _stamp = Path.Combine(dataDirectory, PlannedRestartFiles.CeilingStampFileName);
        _watchdogLock = Path.Combine(dataDirectory, AgentLiveness.WatchdogLockFileName);
    }

    /// <summary>When the last ceiling restart was requested; <c>null</c> if never (or unreadable).</summary>
    public DateTimeOffset? LastCeilingRestart()
    {
        try
        {
            return File.Exists(_stamp) ? PlannedRestartFiles.TryParseStamp(File.ReadAllText(_stamp)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Careful: written <b>before</b> asking to exit, not after. If the exit then stalled or the
    /// process died on the way out, the guard must still hold; otherwise a fresh process would see
    /// no stamp and restart again at once.
    /// </summary>
    public bool TryStampCeilingRestart(DateTimeOffset utc, out string? error) =>
        TryWriteAtomically(_stamp, PlannedRestartFiles.FormatStamp(utc), out error);

    public bool TryWriteMarker(PlannedRestart restart, out string? error) =>
        TryWriteAtomically(_marker, PlannedRestartFiles.Format(restart), out error);

    /// <summary>
    /// Is a watchdog holding <c>watchdog.lock</c> right now? Only a sharing violation counts as
    /// "yes"; anything else (free, missing folder, no access) is "no".
    ///
    /// Careful: "cannot tell" is deliberately "no". Exiting without a watchdog leaves the PC
    /// untracked until the next logon, which is far worse than a leaking agent that keeps counting.
    ///
    /// Careful: opening the file for a moment is itself a tiny race: a watchdog starting in that
    /// very millisecond would find the lock taken and exit. The handle is held for microseconds,
    /// and this runs only when the agent is already over its ceiling (once a minute at most), so
    /// the window is far smaller than the one the watchdog's own probe of <c>agent.lock</c> has.
    /// </summary>
    public bool WatchdogPresent()
    {
        try
        {
            using var _ = new FileStream(
                _watchdogLock, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return false;
        }
        catch (IOException ex) when ((ex.HResult & 0xFFFF) is ErrorSharingViolation or ErrorLockViolation)
        {
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>The current unbiased clock in ms, the same one <c>agent.alive</c> is stamped with.</summary>
    public static long? UnbiasedMs() =>
        Kernel32.QueryUnbiasedInterruptTime(out var unbiased) ? (long)(unbiased / 10_000) : null;

    private static bool TryWriteAtomically(string path, string line, out string? error)
    {
        error = null;
        try
        {
            // Same discipline as LivenessBeacon: temp, then move, so the watchdog never reads half
            // a line.
            var temp = path + ".tmp";
            File.WriteAllText(temp, line);
            File.Move(temp, path, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            error = ex.Message;
            return false;
        }
    }
}
