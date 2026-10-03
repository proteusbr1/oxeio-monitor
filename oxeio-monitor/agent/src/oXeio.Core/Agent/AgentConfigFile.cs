using System.Text;

namespace oXeio.Core.Agent;

/// <summary>
/// <see cref="CachedAgentConfig"/> on disk — <c>agent-config.json</c> in the
/// agent's data folder.
///
/// ⚠️ Written atomically (temp file, flush to disk, then rename over the old
/// one), the same way the device token is. A power cut halfway through a plain
/// overwrite would leave a half-written file, and the next boot would fall
/// back to the default policy — the very thing this file exists to prevent.
///
/// ⚠️ Never throws. Not being able to read or write the cache only means the
/// next boot starts on the default config, as it always did; an exception
/// here would stop the agent, and with it the counting of hours.
/// </summary>
public sealed class AgentConfigFile
{
    public const string FileName = "agent-config.json";

    /// <summary>A real config is a few hundred bytes; anything this big is not ours.</summary>
    private const long MaxBytes = 64 * 1024;

    private readonly string _path;

    public AgentConfigFile(string directory)
    {
        _path = Path.Combine(directory, FileName);
    }

    /// <summary>The last good config, or <c>null</c> (none yet, unreadable, or invalid).</summary>
    public CachedAgentConfig? TryLoad()
    {
        try
        {
            var info = new FileInfo(_path);
            if (!info.Exists || info.Length > MaxBytes) return null;

            return AgentConfigCacheCodec.TryDeserialize(File.ReadAllText(_path, Encoding.UTF8));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Keeps <paramref name="cached"/> — only if <see cref="AgentConfigCheck"/>
    /// accepts it, so a broken config never replaces a good one.
    /// </summary>
    public bool TrySave(CachedAgentConfig cached)
    {
        if (string.IsNullOrWhiteSpace(cached.Version) || !AgentConfigCheck.IsUsable(cached.Config))
            return false;

        var temp = _path + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            var bytes = Encoding.UTF8.GetBytes(AgentConfigCacheCodec.Serialize(cached));
            using (var fs = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(flushToDisk: true);
            }

            File.Move(temp, _path, overwrite: true);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(temp); } catch (Exception) { /* leftover temp is harmless */ }
            return false;
        }
    }
}
