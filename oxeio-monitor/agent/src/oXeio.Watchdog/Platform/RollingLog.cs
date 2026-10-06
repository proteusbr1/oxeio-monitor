using System.Globalization;
using System.Runtime.Versioning;
using System.Text;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// A small self-rotating log. No external library.
///
/// <b>Size budget:</b> a ceiling of 512 KiB and a single old copy (<c>.1</c>), so at
/// most 1 MiB on disk, forever. This process runs for weeks at a time and nobody reads
/// the log; without a limit it would eventually fill the disk.
///
/// Careful: <b>it does not write on every tick.</b> One line every 30 seconds is 2,880
/// a day, which means rotating twice a day and losing exactly the line that matters
/// (the crash from two weeks ago). So <see cref="WatchdogLoop"/> writes only
/// <b>changes</b>, not the current state.
///
/// Careful: no method throws. If the disk is full, writing the log fails, but the
/// supervision keeps going. A log problem must never stop the hour counting.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class RollingLog
{
    private const long DefaultMaxBytes = 512 * 1024;

    private readonly string _path;
    private readonly long _maxBytes;
    private readonly object _gate = new();

    public RollingLog(string path, long maxBytes = DefaultMaxBytes)
    {
        _path = path;
        _maxBytes = maxBytes > 0 ? maxBytes : DefaultMaxBytes;
    }

    public void Write(string message)
    {
        lock (_gate)
        {
            try
            {
                RotateIfNeeded();

                var line = string.Create(
                    CultureInfo.InvariantCulture,
                    $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}  {message}{Environment.NewLine}");

                // FileShare.ReadWrite so that an admin who has the log open does not
                // block writing. To us this file is only a place to write, not a source of truth.
                using var stream = new FileStream(
                    _path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite, 4096, FileOptions.None);

                var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(line);
                stream.Write(bytes, 0, bytes.Length);
            }
            catch (Exception)
            {
                // Swallowed on purpose: throwing here would kill the watchdog.
            }
        }
    }

    private void RotateIfNeeded()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Length < _maxBytes) return;

            var previous = _path + ".1";

            // Careful: Move(overwrite: true). Deleting first and then moving would
            // leave neither file if the process died between the two steps.
            File.Move(_path, previous, overwrite: true);
        }
        catch (Exception)
        {
            // If rotation fails the file just grows a bit; better than stopping writes.
        }
    }
}
