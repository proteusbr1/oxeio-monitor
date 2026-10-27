using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;

using Microsoft.Win32.SafeHandles;

using oXeio.Agent.Native;
using oXeio.Core.Agent;

namespace oXeio.Agent.Sync;

/// <summary>
/// <b>H1:</b> a staged MSI held open so that nobody can change it between "verified" and
/// "msiexec has read it". See <see cref="UpdateStager.LockForInstall"/> for the attack.
///
/// What is held, and why each one:
/// <list type="bullet">
/// <item><b>the MSI</b>, read access, share mode <c>FILE_SHARE_READ</c> only. Windows then refuses
/// every other open that asks for write access, and every rename or delete (both need
/// <c>DELETE</c> access, which our share mode does not allow). msiexec opens the package for
/// <b>reading</b> with read sharing, so it still can. And if someone already holds the file open
/// for writing, <b>our</b> open fails with a sharing violation, which is refused: a writer that
/// is already in cannot be locked out after the fact.</item>
/// <item><b>the updates folder and its parent</b>, without <c>FILE_SHARE_DELETE</c>, so neither
/// can be renamed away and replaced by a junction while msiexec is starting. Without this, the
/// path given to msiexec could be made to point somewhere else even though the file itself is
/// locked: users have Modify (which includes <c>DELETE</c>) on the <c>updates</c> folder.</item>
/// </list>
///
/// Careful: <b>everything is opened with <c>FILE_FLAG_OPEN_REPARSE_POINT</c></b>, so a junction or
/// symlink is opened as itself, seen, and refused, instead of being followed. On top of that,
/// the MSI's <b>final path</b> (from <c>GetFinalPathNameByHandle</c>, after every link) must equal
/// the path that was expected; that catches a link anywhere above the pinned folders too. That
/// final path is what msiexec is given.
///
/// Careful, residual risks (no code can close these from a standard-user process):
/// <list type="bullet">
/// <item>an administrator or SYSTEM can still change anything; they do not need this trick.</item>
/// <item>the lock lives in the agent's process. The MSI's own <c>StopAgent</c> action kills that
/// process mid-install, which closes the handles. By then Windows Installer has opened the
/// package itself (with its own read handle), so this is believed safe, but it is the part that
/// most needs checking on a real Windows install (see the commit message).</item>
/// <item>a hard link to the MSI elsewhere does not matter: all names share the same locked
/// data.</item>
/// </list>
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class UpdateLock : IDisposable
{
    private readonly SafeFileHandle _file;
    private readonly SafeFileHandle[] _folders;

    /// <summary>The path to hand to msiexec: the file's canonical path, resolved from the
    /// handle.</summary>
    public string FinalPath { get; }

    private UpdateLock(SafeFileHandle file, SafeFileHandle[] folders, string finalPath)
    {
        _file = file;
        _folders = folders;
        FinalPath = finalPath;
    }

    /// <summary>
    /// Locks <paramref name="msiPath"/>, which must be directly inside
    /// <paramref name="updatesDirectory"/>. On failure, <paramref name="why"/> says why and
    /// nothing stays open.
    /// </summary>
    public static bool TryAcquire(
        string updatesDirectory, string msiPath, out UpdateLock held, out string why)
    {
        held = null!;
        var opened = new List<SafeFileHandle>();

        try
        {
            var updates = Path.GetFullPath(updatesDirectory);
            var expected = Path.GetFullPath(msiPath);

            if (!UpdateFiles.IsDirectChild(updates, expected))
            {
                why = $"{expected} is not inside {updates}";
                return false;
            }

            // Folders first, outermost first: once a folder is pinned, nothing under it can be
            // moved away, so what is opened next is really under it.
            var parent = Path.GetDirectoryName(updates);
            foreach (var folder in new[] { parent, updates })
            {
                if (string.IsNullOrEmpty(folder)) continue;

                // Careful: FILE_LIST_DIRECTORY must be asked for, not only FILE_READ_ATTRIBUTES.
                // Windows does not record (or enforce) the share mode of an open that asks for
                // nothing but attributes, so such a handle would block no rename at all.
                var handle = Open(folder, Kernel32.FILE_LIST_DIRECTORY | Kernel32.FILE_READ_ATTRIBUTES,
                    Kernel32.FILE_SHARE_READ | Kernel32.FILE_SHARE_WRITE,
                    Kernel32.FILE_FLAG_BACKUP_SEMANTICS);
                if (handle is null)
                {
                    why = $"could not open {folder}: {LastError()}";
                    return false;
                }

                opened.Add(handle);

                var attributes = File.GetAttributes(handle);
                if (attributes.HasFlag(FileAttributes.ReparsePoint))
                {
                    why = $"{folder} is a junction or link";
                    return false;
                }
            }

            var file = Open(expected, Kernel32.GENERIC_READ, Kernel32.FILE_SHARE_READ,
                Kernel32.FILE_FLAG_SEQUENTIAL_SCAN);
            if (file is null)
            {
                // a sharing violation here means someone holds it open for writing right now
                why = $"could not lock the file: {LastError()}";
                return false;
            }

            opened.Add(file);

            var fileAttributes = File.GetAttributes(file);
            if (fileAttributes.HasFlag(FileAttributes.ReparsePoint) ||
                fileAttributes.HasFlag(FileAttributes.Directory))
            {
                why = "the file is a link or a folder";
                return false;
            }

            var final = FinalPathOf(file);
            if (final is null)
            {
                why = $"could not resolve where the file really is: {LastError()}";
                return false;
            }

            if (!string.Equals(final, expected, StringComparison.OrdinalIgnoreCase))
            {
                why = $"its real location ({final}) differs from {expected}, " +
                      "so a link or junction is in the way";
                return false;
            }

            held = new UpdateLock(file, opened.Take(opened.Count - 1).ToArray(), final);
            opened.Clear();
            why = "";
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            why = ex.Message;
            return false;
        }
        finally
        {
            // on success the list was emptied; on any failure nothing stays locked
            foreach (var handle in opened) handle.Dispose();
        }
    }

    /// <summary>
    /// SHA-256 (lowercase hex) of the bytes <b>behind the locked handle</b>, read by offset so
    /// the handle's own position does not matter.
    /// </summary>
    public string ComputeSha256()
    {
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[128 * 1024];
        long offset = 0;
        int read;

        while ((read = RandomAccess.Read(_file, buffer, offset)) > 0)
        {
            hasher.AppendData(buffer, 0, read);
            offset += read;
        }

        return Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant();
    }

    /// <summary>
    /// Keeps the lock until <paramref name="msiexec"/> exits, or <paramref name="atMost"/>
    /// passes, then releases it. Runs in the background; never throws.
    ///
    /// Careful: <b>"until msiexec exits", not "until it has started".</b> msiexec reads the
    /// package well after its process starts: first the UAC prompt (as long as the admin takes),
    /// then the install itself. Releasing the lock right after <c>Process.Start</c> would put the
    /// time-of-check / time-of-use gap straight back.
    ///
    /// Careful: the upper bound exists so an msiexec that never exits (a hung install) does not
    /// pin the file and folders forever; after it, the next update could not replace the MSI.
    /// </summary>
    public void ReleaseAfter(System.Diagnostics.Process? msiexec, TimeSpan atMost)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var timeout = new CancellationTokenSource(atMost);
                if (msiexec is not null)
                    await msiexec.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                else
                    await Task.Delay(atMost, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // timeout, or the process object is unusable: release either way
            }
            finally
            {
                msiexec?.Dispose();
                Dispose();
            }
        });
    }

    public void Dispose()
    {
        _file.Dispose();
        foreach (var folder in _folders) folder.Dispose();
    }

    private static SafeFileHandle? Open(string path, uint access, uint share, uint flags)
    {
        var handle = Kernel32.CreateFile(
            path, access, share, 0, Kernel32.OPEN_EXISTING,
            flags | Kernel32.FILE_FLAG_OPEN_REPARSE_POINT, 0);

        if (!handle.IsInvalid) return handle;

        handle.Dispose();
        return null;
    }

    private static string? FinalPathOf(SafeFileHandle handle)
    {
        var buffer = new char[1024];
        var length = Kernel32.GetFinalPathNameByHandle(
            handle, buffer, (uint)buffer.Length, Kernel32.FILE_NAME_NORMALIZED | Kernel32.VOLUME_NAME_DOS);

        if (length == 0 || length >= buffer.Length) return null;

        return StripDevicePrefix(new string(buffer, 0, (int)length));
    }

    /// <summary>
    /// <c>GetFinalPathNameByHandle</c> answers in the <c>\\?\</c> form:
    /// <c>\\?\C:\ProgramData\x</c>, or <c>\\?\UNC\server\share\x</c> for a network path. This
    /// gives the ordinary form, which is what the expected path looks like and what msiexec is
    /// used to.
    /// </summary>
    internal static string StripDevicePrefix(string path)
    {
        const string Unc = @"\\?\UNC\";
        const string Local = @"\\?\";

        if (path.StartsWith(Unc, StringComparison.OrdinalIgnoreCase))
            return @"\\" + path[Unc.Length..];

        return path.StartsWith(Local, StringComparison.Ordinal) ? path[Local.Length..] : path;
    }

    private static string LastError() => new Win32Exception(Marshal.GetLastPInvokeError()).Message;
}
