using System.Runtime.Versioning;

namespace oXeio.Agent.Storage;

/// <summary>
/// Every path on the agent's disk lives here; no other place writes a directory name.
///
/// This is not just about tidy code. The outbox rows and the .webp files are written by two
/// different modules; if they assumed different folders, a row would say a file exists
/// while the file sits somewhere else on disk. Uploads would then fail forever and the
/// orphaned files would never be counted in any budget.
///
/// <b>Why %ProgramData%:</b> it survives deleting a user profile or resetting a roaming
/// profile, and there is one copy per machine. IT regularly resets profiles on office PCs,
/// and a week of queue kept under %AppData% would silently evaporate.
///
/// Careful, ACL trap: if the (elevated) installer creates <c>C:\ProgramData\oXeio</c>, an
/// ordinary user can only read there, not write, because in ProgramData's default ACL Users
/// get read+execute and CREATOR OWNER's full control applies only to whoever created it.
/// The result: the agent starts but cannot write a single row. So the installer must grant
/// Users Modify on that folder, and <see cref="Resolve"/> here verifies by writing a real
/// file. If that fails it falls back to %LOCALAPPDATA% (the queue is lost if the profile is
/// deleted, but the agent at least keeps collecting data, which beats counting nothing).
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class OutboxPaths
{
    public const string AppFolderName = "oXeio";

    /// <summary>Write-permission probe file. Harmless if left behind, so the name is fixed.</summary>
    private const string ProbeFileName = ".write-probe";

    private static OutboxPaths? _default;

    private OutboxPaths(string root, bool isFallback, string resolutionNote)
    {
        Root = root;
        IsFallback = isFallback;
        ResolutionNote = resolutionNote;

        Database = Path.Combine(root, "outbox.db");
        QueueRoot = Path.Combine(root, "queue");
        ScreenshotQueue = Path.Combine(QueueRoot, "screenshots");
        Logs = Path.Combine(root, "logs");
        Updates = Path.Combine(root, "updates");
        State = Path.Combine(root, "state");
    }

    public string Root { get; }

    /// <summary>%ProgramData% could not be used, so we fell back to %LOCALAPPDATA%.</summary>
    public bool IsFallback { get; }

    /// <summary>Why this root was chosen; written verbatim to the startup log.</summary>
    public string ResolutionNote { get; }

    public string Database { get; }

    /// <summary>SQLite creates the WAL files itself; here for diagnostics and backups only.</summary>
    public string DatabaseWal => Database + "-wal";
    public string DatabaseShm => Database + "-shm";

    public string QueueRoot { get; }

    /// <summary>
    /// The .webp bytes live here, not inside the DB.
    ///
    /// Careful: storing screenshots as BLOBs in the queue (200 KB x 864 screenshots a day)
    /// would grow the DB by 170 MB a day, and after every DELETE those pages would sit empty
    /// inside the file; the disk space only comes back with VACUUM, which locks the whole DB.
    /// With separate files, deleting a file frees the space immediately.
    /// </summary>
    public string ScreenshotQueue { get; }

    public string Logs { get; }
    public string Updates { get; }
    public string State { get; }

    /// <summary>Computed once per process; the disk is not probed every time.</summary>
    public static OutboxPaths Default => _default ??= Resolve();

    /// <summary>For tests or forcing a different root (no verification).</summary>
    public static OutboxPaths ForRoot(string root) =>
        new(Path.GetFullPath(root), isFallback: false, resolutionNote: "explicit root");

    /// <summary>
    /// Picks the root. Careful: never throws. If the process died while resolving paths at
    /// startup, the agent would be in a crash loop forever and nobody would notice.
    /// </summary>
    public static OutboxPaths Resolve()
    {
        var programData = SafeFolder(Environment.SpecialFolder.CommonApplicationData);
        if (programData is not null)
        {
            var root = Path.Combine(programData, AppFolderName);
            if (TryPrepare(root, out var why))
                return new OutboxPaths(root, isFallback: false, $"%ProgramData%\\{AppFolderName}");

            var localAppData = SafeFolder(Environment.SpecialFolder.LocalApplicationData);
            if (localAppData is not null)
            {
                var alt = Path.Combine(localAppData, AppFolderName);
                if (TryPrepare(alt, out _))
                {
                    return new OutboxPaths(alt, isFallback: true,
                        $"%LOCALAPPDATA%\\{AppFolderName} — ProgramData was not writable ({why})");
                }
            }

            // Both failed: still return the ProgramData path, so the log shows the real path
            // and the real reason. Opening the store will then give a clear error.
            return new OutboxPaths(root, isFallback: false, $"⚠️ nowhere is writable ({why})");
        }

        // SpecialFolder returned an empty string (unusual, but possible): at least run from temp
        var temp = Path.Combine(Path.GetTempPath(), AppFolderName);
        return new OutboxPaths(temp, isFallback: true, "⚠️ temp — SpecialFolder was not available");
    }

    /// <summary>Creates all the folders. Safe to call repeatedly.</summary>
    public void EnsureCreated()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(QueueRoot);
        Directory.CreateDirectory(ScreenshotQueue);
        Directory.CreateDirectory(Logs);
        Directory.CreateDirectory(Updates);
        Directory.CreateDirectory(State);
    }

    /// <summary>
    /// Destination of one screenshot. Creates the folder as well.
    ///
    /// Why a subfolder per date: 288 slots x 3 monitors over seven days is about 6,000 files.
    /// NTFS would cope with one folder, but sweeping orphan files would have to read the whole
    /// list every time; with a date split, once an old day's folder is empty the whole folder
    /// can be removed at once.
    ///
    /// Careful: folder/file names use UTC. With local time, a clock set back or a DST-style
    /// jump could produce the same name twice. On top of that the name contains
    /// <paramref name="clientUuid"/>, so a collision is impossible.
    /// </summary>
    public string NewScreenshotPath(DateTimeOffset slotStart, int monitorIndex, Guid clientUuid)
    {
        var utc = slotStart.UtcDateTime;
        var dayDir = Path.Combine(ScreenshotQueue, utc.ToString("yyyy-MM-dd"));
        Directory.CreateDirectory(dayDir);

        var name = $"{utc:HHmmss}-m{monitorIndex}-{clientUuid:N}.webp";
        return Path.Combine(dayDir, name);
    }

    /// <summary>
    /// Where the 320px thumbnail of that screenshot lives.
    ///
    /// <b>This is the only definition of the rule.</b> Four places know this path: writing
    /// (AgentHost), sending (HttpSyncClient), deleting (DeleteFiles) and the orphan sweep
    /// (SweepOrphanFiles). If any one followed a different rule, either the thumbnail would
    /// never be sent or the sweeper would <b>delete</b> every thumbnail.
    ///
    /// Careful: the ending stays <c>.webp</c> so that the sweeper's <c>*.webp</c> pattern
    /// catches it; an orphaned screenshot's thumbnail must not be left behind either.
    /// </summary>
    public static string ThumbPathFor(string webpPath) =>
        Path.ChangeExtension(webpPath, null) + "-thumb.webp";

    /// <summary>
    /// Removes date folders that have become empty. Returns how many were removed.
    /// Failures are swallowed; stopping tracking over folder cleanup makes no sense.
    /// </summary>
    public int PruneEmptyScreenshotFolders()
    {
        var removed = 0;
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(ScreenshotQueue))
            {
                try
                {
                    if (Directory.EnumerateFileSystemEntries(dir).Any()) continue;
                    Directory.Delete(dir);
                    removed++;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (DirectoryNotFoundException) { }
        catch (UnauthorizedAccessException) { }

        return removed;
    }

    /// <summary>
    /// Whether the folder is really writable. <c>Directory.CreateDirectory</c> succeeding is
    /// not enough proof: if the folder already exists it succeeds without doing anything even
    /// when we have no write permission. So we write a real file and see.
    /// </summary>
    private static bool TryPrepare(string root, out string why)
    {
        try
        {
            Directory.CreateDirectory(root);

            var probe = Path.Combine(root, ProbeFileName);
            File.WriteAllBytes(probe, []);
            File.Delete(probe);

            why = "";
            return true;
        }
        // Careful: catching every exception is deliberate. SecurityException,
        // PathTooLongException, odd IOExceptions from filter drivers, anything can come here,
        // and if the process died while choosing the path at startup the machine would be
        // in a crash loop forever. We only need one answer: "can we write here or not".
        catch (Exception ex)
        {
            why = $"{ex.GetType().Name}: {ex.Message}";
            return false;
        }
    }

    private static string? SafeFolder(Environment.SpecialFolder folder)
    {
        try
        {
            var path = Environment.GetFolderPath(folder);
            return string.IsNullOrWhiteSpace(path) ? null : path;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
