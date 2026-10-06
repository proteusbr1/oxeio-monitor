using System.Globalization;
using System.Runtime.Versioning;
using System.Text;

using oXeio.Agent.Sync;
using oXeio.Core.Agent;

namespace oXeio.Agent.Storage;

/// <summary>
/// The agent's own log file, limited to 7 days / 50 MB.
///
/// Important: <b>this file used to not exist at all.</b> The only implementation of
/// <see cref="ISyncLog"/> was <c>ConsoleSyncLog</c>, and the project is <c>WinExe</c>, so
/// there is no console. Every agent line therefore went <b>nowhere</b>: failed enrollment,
/// revoked token, 422 rejections, update downloads, none of it left a trace. Yet
/// <c>deploy/README.md</c> told people to read <c>agent.log</c> when something went wrong,
/// and that file had never been written.
///
/// <b>Two kinds of file name, on purpose:</b>
/// <list type="bullet">
/// <item>The current file is always <c>agent.log</c>: the runbook can name a single path,
/// and IT does not have to be told to "fill in today's date".</item>
/// <item>When the day changes it is renamed to <c>agent-YYYY-MM-DD.log</c>, so the 7-day
/// count can be read from the date in the name and does not depend on the file's mtime
/// (mtime changes on copy/backup).</item>
/// </list>
///
/// Careful: <b>no method of this class ever throws</b>. Failing to write the log (disk full,
/// file locked) must not stop the agent; otherwise a logging problem would become a
/// data-loss problem.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class FileLog : ISyncLog
{
    /// <summary>Name of the current file; the runbook says exactly this.</summary>
    public const string CurrentFileName = "agent.log";

    private const string ArchivePrefix = "agent-";
    private const string ArchiveSuffix = ".log";

    private readonly object _gate = new();
    private readonly string _directory;
    private readonly string _path;
    private readonly UTF8Encoding _utf8 = new(encoderShouldEmitUTF8Identifier: false);

    /// <summary>
    /// Important: <b>a UTF-8 BOM must be written at the start of a new file.</b>
    ///
    /// The runbook tells admins to run <c>Get-Content …gent.log -Tail 50</c>, and
    /// <b>Windows PowerShell 5.1 treats a file without a BOM as ANSI</b>, so every
    /// <c>·</c> <c>—</c> <c>✅</c> shows up garbled as <c>Â·</c> <c>â€”</c>
    /// <c>âœ…</c>. The file is written correctly but cannot be read, and whoever opened
    /// the log to find a problem first assumes the file itself is corrupt.
    ///
    /// Notepad does the same: without a BOM it assumes ANSI.
    ///
    /// The same mistake was caught in <c>installer/build.ps1</c> from the opposite side:
    /// with no BOM, PowerShell could not <b>parse</b> the script at all. So the rule is
    /// written down here: <b>give any text file that people will read on Windows a BOM.</b>
    /// </summary>
    private static readonly byte[] Bom = [0xEF, 0xBB, 0xBF];

    /// <summary>The day currently being written; when it changes, the file must be rolled.</summary>
    private DateOnly _openDay;

    public FileLog(string logsDirectory)
    {
        _directory = logsDirectory;
        _path = Path.Combine(logsDirectory, CurrentFileName);

        // Careful: at startup we find out the file's real day instead of assuming today.
        // If the PC was off for three days the file is three days old; assuming today would
        // append today's lines to that old file and mess up the split by day.
        _openDay = ExistingDay() ?? DateOnly.FromDateTime(DateTime.Now);
    }

    public string FilePath => _path;

    public void Info(string message) => Write("INFO ", message);
    public void Warn(string message) => Write("WARN ", message);

    public void Error(string message, Exception? error = null) =>
        Write("ERROR", error is null
            ? message
            : $"{message} — {error.GetType().Name}: {error.Message}");

    /// <summary>
    /// One line when the agent starts: which version, which server, where the data is.
    /// These are the first questions when investigating a problem, and without this line
    /// there would be no way to tell which run the rest of the log belongs to.
    /// </summary>
    public void Startup(string version, string serverUrl, string dataRoot)
    {
        Write("INFO ", new string('─', 60));
        Write("INFO ", $"oXeio agent {version} starting · server {serverUrl}");
        Write("INFO ", $"data {dataRoot} · log {_path}");
    }

    private void Write(string level, string message)
    {
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(_directory);
                RollIfNewDay();

                var line = string.Create(
                    CultureInfo.InvariantCulture,
                    $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}  {level}  {message}{Environment.NewLine}");

                // Careful: FileShare.ReadWrite, so that writing is not blocked even when IT has
                // the log open (Notepad, Get-Content -Wait). For us this file is only a place
                // to write, not a source of truth.
                using var stream = new FileStream(
                    _path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite, 4096, FileOptions.None);

                // Careful: only on an empty file. Writing it every time would leave BOMs in
                // the middle and corrupt lines. It is written again when a new day starts a file.
                if (stream.Length == 0) stream.Write(Bom, 0, Bom.Length);

                var bytes = _utf8.GetBytes(line);
                stream.Write(bytes, 0, bytes.Length);
            }
            catch (Exception)
            {
                // deliberate silence; see the class doc above
            }
        }
    }

    /// <summary>
    /// If the day has changed, moves the current file to a dated name, then prunes the old
    /// ones.
    ///
    /// Careful: pruning happens only <b>when rolling</b>, once a day, not on every line.
    /// Doing it per line would scan a directory on every log write, thousands of times on
    /// a busy day.
    /// </summary>
    private void RollIfNewDay()
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        if (today == _openDay) return;

        try
        {
            if (File.Exists(_path))
            {
                var archive = Path.Combine(
                    _directory,
                    $"{ArchivePrefix}{_openDay:yyyy-MM-dd}{ArchiveSuffix}");

                // Careful: overwrite: true. If the clock moves back and the same date comes
                // twice, Move would throw and log writing would stop permanently (the same
                // failing Move on every line).
                File.Move(_path, archive, overwrite: true);
            }
        }
        catch (Exception)
        {
            // If rolling fails the file just keeps growing; better than stopping writes
        }

        // Careful: _openDay is updated in every case, even if Move failed. Otherwise every
        // line would retry the same failing Move.
        _openDay = today;

        Prune(today);
    }

    /// <summary>
    /// 7 days / 50 MB. The decision belongs to <see cref="LogRetention"/>; this method only
    /// does the disk work.
    /// </summary>
    private void Prune(DateOnly today)
    {
        try
        {
            var archives = new List<LogRetention.LogFile>();

            foreach (var path in Directory.EnumerateFiles(
                         _directory, $"{ArchivePrefix}*{ArchiveSuffix}"))
            {
                var day = DayFromName(Path.GetFileName(path));
                if (day is null) continue;

                var info = new FileInfo(path);
                archives.Add(new LogRetention.LogFile(path, day.Value, info.Length));
            }

            var active = File.Exists(_path) ? new FileInfo(_path).Length : 0;

            foreach (var doomed in LogRetention.Plan(archives, active, today))
            {
                try
                {
                    File.Delete(doomed.Path);
                }
                catch (Exception)
                {
                    // if one file cannot be deleted, let the rest go on
                }
            }
        }
        catch (Exception)
        {
            // if pruning fails the disk fills slightly more; better than the log stopping
        }
    }

    /// <summary>The day of the current file's last write. <c>null</c> if it does not exist.</summary>
    private DateOnly? ExistingDay()
    {
        try
        {
            var info = new FileInfo(_path);
            return info.Exists ? DateOnly.FromDateTime(info.LastWriteTime) : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// <c>agent-2026-08-12.log</c> → 2026-08-12.
    ///
    /// Careful: read from the name, not from the mtime. Copying the file, restoring from a
    /// backup or running robocopy changes the mtime, and a seven-day-old log would suddenly
    /// become "today's" and never be deleted.
    /// </summary>
    internal static DateOnly? DayFromName(string fileName)
    {
        if (!fileName.StartsWith(ArchivePrefix, StringComparison.OrdinalIgnoreCase)) return null;
        if (!fileName.EndsWith(ArchiveSuffix, StringComparison.OrdinalIgnoreCase)) return null;

        var middle = fileName[ArchivePrefix.Length..^ArchiveSuffix.Length];

        return DateOnly.TryParseExact(
            middle, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null;
    }
}
