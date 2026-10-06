using System.Runtime.Versioning;
using System.Text;

namespace oXeio.Agent.Ui;

/// <summary>
/// The tray is not allowed to know about the disk; it only asks this much.
/// In tests a memory-based fake takes its place.
/// </summary>
internal interface IMilestoneMemory
{
    string? LastCelebrated();

    void Remember(string monthKey);
}

/// <summary>
/// The month in which the J03 balloon was shown: one line on disk, that is all.
///
/// Careful: <b>it has to be kept on disk.</b> In memory only, "once a month" would in
/// practice be "once per restart", and office PCs are switched off every night, so after the
/// target is met there would be a balloon every morning for the rest of the month.
///
/// Careful: <b>it never throws, on any path.</b> If the file cannot be written (disk full,
/// ACL) the worst that happens is that the balloon is seen once more. An exception cannot be
/// thrown into the tray's render path for that risk: that is the UI thread, and an exception
/// escaping there stops the whole agent, which means hours stop being counted.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class MilestoneMemory : IMilestoneMemory
{
    private const string FileName = "milestone.txt";

    /// <summary>The key is <c>YYYY-MM</c>; so we do not swallow corrupt/odd lines.</summary>
    private const int MaxKeyLength = 16;

    private readonly string _path;

    /// <summary>At most once per run, even if disk reads/writes fail.</summary>
    private string? _cached;
    private bool _loaded;

    public MilestoneMemory(string directory)
    {
        _path = Path.Combine(directory, FileName);
    }

    /// <summary>The last month it was shown, or <c>null</c> if unknown.</summary>
    public string? LastCelebrated()
    {
        if (_loaded) return _cached;

        _loaded = true;

        try
        {
            if (File.Exists(_path))
            {
                var text = File.ReadAllText(_path, Encoding.UTF8).Trim();
                if (text.Length is > 0 and <= MaxKeyLength) _cached = text;
            }
        }
        catch (Exception)
        {
            // Could not read: we assume "never shown". At worst one extra balloon; assuming the
            // opposite would suppress a genuine achievement.
        }

        return _cached;
    }

    /// <summary>Records that it was shown this month. Stays in memory even if the write fails.</summary>
    public void Remember(string monthKey)
    {
        if (string.IsNullOrWhiteSpace(monthKey)) return;

        _cached = monthKey;
        _loaded = true;

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path, monthKey, Encoding.UTF8);
        }
        catch (Exception)
        {
            // One more balloon at the next restart; there is no bigger harm than that
        }
    }
}
