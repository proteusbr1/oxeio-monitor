using System.Runtime.Versioning;

using oXeio.Core.Watchdog;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// All files in one place: <c>%ProgramData%\oXeio\</c> (07-Technical-Spec section 3.5).
///
/// The installer must grant the <b>Users</b> group Modify on this folder. By default a
/// subfolder of %ProgramData% can be written only by whoever created it; without the grant a
/// standard user's agent could not even open queue.db, and the watchdog would see "probe
/// failed" every time and sit with its hands in its pockets.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class AgentPaths
{
    /// <summary>The agent's exe name: the AssemblyName in <c>oXeio.Agent.csproj</c>.</summary>
    internal const string AgentExeName = "oXeio.Agent.exe";

    /// <summary>The process name for pid verification (no extension).</summary>
    internal const string AgentProcessName = "oXeio.Agent";

    internal AgentPaths(string dataDirectory) => DataDirectory = dataDirectory;

    internal static AgentPaths Default => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "oXeio"));

    internal string DataDirectory { get; }

    internal string Heartbeat => Path.Combine(DataDirectory, AgentLiveness.HeartbeatFileName);
    internal string AgentLock => Path.Combine(DataDirectory, AgentLiveness.AgentLockFileName);
    internal string WatchdogLock => Path.Combine(DataDirectory, AgentLiveness.WatchdogLockFileName);
    internal string Alarm => Path.Combine(DataDirectory, AgentLiveness.AlarmFileName);
    internal string Log => Path.Combine(DataDirectory, AgentLiveness.WatchdogLogFileName);
    internal string StopFile => Path.Combine(DataDirectory, AgentLiveness.StopFileName);

    /// <summary>Creates the folder if it is missing. false if it cannot; the caller writes that to the log.</summary>
    internal bool EnsureDirectory()
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>
    /// Where the agent's exe is. By default in the watchdog's own folder: the MSI keeps the
    /// two together.
    ///
    /// PATH is deliberately not searched. The watchdog runs at logon, and users can put
    /// anything on their own PATH; searching it would let any staff member run their own
    /// <c>oXeio.Agent.exe</c> and make up the hours count as they like.
    /// </summary>
    internal static string? ResolveAgentExecutable(string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath))
            return File.Exists(explicitPath) ? Path.GetFullPath(explicitPath) : null;

        var beside = Path.Combine(AppContext.BaseDirectory, AgentExeName);
        return File.Exists(beside) ? beside : null;
    }
}
