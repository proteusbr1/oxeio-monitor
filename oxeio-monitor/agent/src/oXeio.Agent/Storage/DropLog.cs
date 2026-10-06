using System.Runtime.Versioning;
using System.Text;

namespace oXeio.Agent.Storage;

/// <summary>
/// The only witness to data that will never reach the server.
///
/// Data leaves the outbox for good in three ways: permanent rejection by the server
/// (<c>AbandonAsync</c>), the disk budget (<c>EvictAsync</c>), and age.
/// The doc on <see cref="oXeio.Core.Agent.IOutboxStore.AbandonAsync"/> says silent deletion
/// is not allowed. The reason is brutally practical: a machine that gets 422 could quietly
/// discard data for months, and the report would only show "their hours are low".
/// Nobody would suspect the agent; they would suspect the staff member.
///
/// Careful: this is not a normal logger and does not want to be. Whoever writes the agent's
/// real logger, this file is still written if that logger crashes, is off or does not exist
/// yet, because losing the fact "I deleted data" is worse than losing the data itself.
/// So it has no dependencies and never lets an exception escape.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class DropLog
{
    /// <summary>
    /// Rotated once past 1 MiB. Kept small on purpose: if trimming is running because the
    /// disk is full, filling the disk further with a log would be absurd.
    /// </summary>
    private const long MaxBytes = 1024 * 1024;

    private readonly object _gate = new();
    private readonly string _path;
    private readonly string _rotated;

    public DropLog(string logsDirectory)
    {
        _path = Path.Combine(logsDirectory, "outbox-drops.log");
        _rotated = _path + ".1";
    }

    /// <summary>Shown in the startup log as "the record of dropped data is here".</summary>
    public string FilePath => _path;

    /// <summary>
    /// Writes one line. Careful: never throws; failing to write the drop log must not stop
    /// uploads.
    /// </summary>
    public void Write(string line)
    {
        // Both the tracking thread and the sync thread can write to the same file.
        // Without the lock, two appends would interleave and break lines.
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                Rotate();

                File.AppendAllText(
                    _path,
                    $"{DateTimeOffset.UtcNow:O}\t{line}{Environment.NewLine}",
                    Encoding.UTF8);
            }
            catch (Exception)
            {
                // Swallowed on purpose. Nothing else can be done here; writing to the
                // console goes nowhere in service mode either.
            }
        }
    }

    /// <summary>Several lines in one batch, to avoid opening the file each time.</summary>
    public void WriteMany(IEnumerable<string> lines)
    {
        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                Rotate();

                var stamp = DateTimeOffset.UtcNow.ToString("O");
                var sb = new StringBuilder();
                foreach (var line in lines)
                    sb.Append(stamp).Append('\t').Append(line).Append(Environment.NewLine);

                if (sb.Length > 0) File.AppendAllText(_path, sb.ToString(), Encoding.UTF8);
            }
            catch (Exception)
            {
            }
        }
    }

    /// <summary>
    /// Keeps exactly one old copy (.1). Careful: must be called while holding the lock.
    /// </summary>
    private void Rotate()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Length <= MaxBytes) return;

            File.Move(_path, _rotated, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
