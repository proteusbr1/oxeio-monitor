using System.Runtime.Versioning;

namespace oXeio.Watchdog.Platform;

/// <summary>Who holds the lock file, or whether that could be determined at all.</summary>
internal enum LockProbe
{
    /// <summary>Nobody holds it.</summary>
    Free,

    /// <summary>Someone holds it.</summary>
    Held,

    /// <summary>Could not be determined. Must not be treated as "free".</summary>
    Unknown,
}

/// <summary>
/// <b>Guarantees that two agents never run at once, using a file lock.</b>
///
/// <b>Why not a mutex:</b> one machine can have two Windows sessions (console + RDP, or
/// fast user switching), and two agents running there would count the same hour twice,
/// which corrupts payroll. A mutex that spans sessions needs a name starting with
/// <c>Global\</c>, and creating a <c>Global\</c> kernel object requires
/// <c>SeCreateGlobalPrivilege</c>, which standard users do not have. So an agent running
/// under a non-admin account could not even create that mutex.
///
/// Opening a file under <c>%ProgramData%</c> with <c>FileShare.None</c> and holding it
/// avoids the problem: it is machine-wide, needs no privilege, and when the process dies
/// (crash, TerminateProcess, power loss) the kernel releases the handle itself, so no
/// stale lock is left behind.
///
/// <b>Three layers of interlock</b> (so Task Scheduler and the watchdog do not both
/// start an agent):
/// <list type="number">
/// <item>Task Scheduler starts <b>only the watchdog</b>, never the agent. So by
/// construction there is a single starter.</item>
/// <item>Still, the agent takes this lock itself and exits immediately if it cannot get
/// it. This is the real safeguard when someone double-clicks the exe, or an old
/// install left a scheduled task behind.</item>
/// <item>The watchdog probes the lock <b>before</b> launching and does not launch if it
/// is held. Careful: a race between the probe and the launch always remains. That is
/// fine, because by (2) the losing copy exits on its own. The probe only prevents
/// pointless process creation and log noise; correctness is not its job.</item>
/// </list>
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class InstanceLock : IDisposable
{
    private const int ErrorSharingViolation = 32;
    private const int ErrorLockViolation = 33;

    private FileStream? _stream;

    private InstanceLock(FileStream stream) => _stream = stream;

    /// <summary>
    /// Tries to take the lock (the watchdog uses this for itself).
    /// <c>null</c> = someone else holds it, or it could not be opened at all.
    /// </summary>
    public static InstanceLock? TryAcquire(string path)
    {
        try
        {
            var stream = new FileStream(
                path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.None);

            return new InstanceLock(stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether someone holds the lock, without keeping it.
    ///
    /// Careful: the <c>using</c> is essential here. If the handle stayed open, the
    /// watchdog would hold the lock itself and the agent could never start, while the
    /// log would look perfectly normal.
    /// </summary>
    public static LockProbe Probe(string path)
    {
        try
        {
            using var stream = new FileStream(
                path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.None);

            return LockProbe.Free;
        }
        catch (IOException ex) when (Win32Code(ex) is ErrorSharingViolation or ErrorLockViolation)
        {
            return LockProbe.Held;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // Missing folder, missing ACL, full disk: none of these mean "no agent".
            // Waiting by mistake costs 30 seconds; starting a second agent by mistake
            // costs an hour counted twice.
            return LockProbe.Unknown;
        }
    }

    /// <summary>
    /// The real Win32 code is in the low 16 bits of <c>IOException.HResult</c>
    /// (0x8007_00XX means FACILITY_WIN32). Matching the message text would not work:
    /// it changes with the locale, and some of these machines may run Windows in another language.
    /// </summary>
    private static int Win32Code(IOException ex) => ex.HResult & 0xFFFF;

    public void Dispose()
    {
        _stream?.Dispose();
        _stream = null;
    }
}
