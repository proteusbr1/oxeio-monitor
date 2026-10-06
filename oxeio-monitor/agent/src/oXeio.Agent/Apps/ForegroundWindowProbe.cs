using System.Diagnostics;
using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Apps;

namespace oXeio.Agent.Apps;

/// <summary>
/// Which window is in front right now (D01, D02).
///
/// <b>There is no keyboard or mouse hook here</b>, and there never will be. Only "which window is
/// in front" and "what is its title", which any user can see by opening Task Manager. This system
/// does not know what is being typed ([04-Features section L](../../../../docs/history/04-Features.md)).
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class ForegroundWindowProbe
{
    /// <summary>
    /// How many characters of the title to read. The server's limit is 1000
    /// (<c>AppUsageDto.windowTitle</c>), so we stop below it: sending more would make the whole
    /// batch fail with a 400, and a 400 means the data is discarded.
    /// </summary>
    private const int MaxTitle = 512;

    /// <summary>
    /// These processes count as browsers; only they get an address-bar read. Careful: outside this
    /// list no URL read is attempted; running UI Automation on every app for no reason is expensive
    /// (about 10-30 ms per call).
    /// </summary>
    private static readonly HashSet<string> Browsers = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc",
    };

    /// <summary>
    /// Process id to name. Careful: without a cache, <c>Process.GetProcessById</c> would be called
    /// every second, and that is comparatively expensive. The cache is kept small because pids are
    /// reused.
    /// </summary>
    private readonly Dictionary<uint, (string Name, string? Title)> _names = [];

    /// <summary>On failure <c>null</c>, not an exception. Losing one sample is not
    /// serious.</summary>
    public WindowSample? Read(Func<nint, string?>? urlReader = null)
    {
        try
        {
            var hwnd = User32.GetForegroundWindow();

            // 0 = no window in front (lock screen, desktop switch)
            if (hwnd == 0) return null;

            if (User32.GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid == 0) return null;

            var (process, appName) = ResolveProcess(pid);
            if (process is null) return null;

            var isBrowser = Browsers.Contains(Path.GetFileNameWithoutExtension(process));
            var title = PeekTitle(hwnd);

            return new WindowSample
            {
                ProcessName = process,
                AppName = appName,
                WindowTitle = title,

                // Careful: the URL is read **only for browsers**, and only if the caller wants it.
                // If the window did not change the caller passes null, to avoid the cost of running
                // UI Automation every second ([06-Research section
                // 2.6](../../../../docs/history/06-Research.md)).
                RawUrl = isBrowser ? urlReader?.Invoke(hwnd) : null,
                IsBrowser = isBrowser,
            };
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Debug.WriteLine($"could not read the foreground window: {ex.Message}");
            return null;
        }
    }

    private (string? Process, string? AppName) ResolveProcess(uint pid)
    {
        if (_names.TryGetValue(pid, out var cached)) return (cached.Name, cached.Title);

        try
        {
            using var p = Process.GetProcessById((int)pid);

            var exe = p.ProcessName + ".exe";

            // Careful: not MainWindowTitle: that is the title of the process's **main** window, and
            // the window in front may be a different one. Only the friendly name is taken here; the
            // title comes from GetWindowText.
            string? friendly = null;
            try { friendly = p.MainModule?.FileVersionInfo.FileDescription; }
            catch (Exception) { /* another user's or a protected process: carry on without the name */ }

            if (_names.Count > 256) _names.Clear(); // pids are reused
            _names[pid] = (exe, friendly);

            return (exe, friendly);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            // The process has already exited
            return (null, null);
        }
    }

    /// <summary>The window title: the caller also needs it to tell whether the URL must be read
    /// again.</summary>
    internal static string? PeekTitle(nint hwnd)
    {
        var length = User32.GetWindowTextLength(hwnd);
        if (length <= 0) return null;

        var size = Math.Min(length + 1, MaxTitle);
        Span<char> buffer = stackalloc char[size];

        int written;
        unsafe
        {
            fixed (char* p = buffer) written = User32.GetWindowText(hwnd, p, size);
        }

        return written <= 0 ? null : new string(buffer[..written]);
    }
}
