using System.Runtime.Versioning;

using oXeio.Core.Agent;
using oXeio.Core.Apps;
using oXeio.Core.Models;

namespace oXeio.Agent.Apps;

/// <summary>
/// The three pieces of app and site tracking in one place (D01-D04): reading from Win32, the
/// browser's address, and the counting rules.
///
/// <b>The address bar is read only when the window or title changes.</b> Running UI Automation
/// every second would cost about 10-30 ms per call, thousands of times a day, and the CPU budget
/// could not be kept under 1% ([06-Research section 2.6](../../../../docs/06-Research.md)).
///
/// It is also read when the title changes, because navigating to a new page in the same window
/// changes the address while the hwnd stays the same.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class AppUsageService
{
    private readonly ForegroundWindowProbe _probe = new();
    private readonly BrowserUrlReader _urls = new();
    private readonly AppUsageTracker _tracker;

    private nint _lastHwnd;
    private string? _lastTitle;
    private string? _lastUrl;

    public AppUsageService(TimeSpan? minDuration = null) =>
        _tracker = new AppUsageTracker(minDuration);

    /// <summary>For diagnostics: which app is currently being counted.</summary>
    public string? CurrentProcess => _tracker.CurrentProcess;

    /// <summary>
    /// A07: which window is in front at the moment an image is taken.
    ///
    /// Careful: Win32 is <b>not</b> queried again; what <see cref="Tick"/> last read is returned
    /// (at most one tick old). That way the name beside the image and the <c>app_usage</c> row come
    /// from the <b>same</b> sample; read separately, they could show different apps, and a mismatch
    /// like "Excel in the image but Chrome in the report" could not be explained.
    /// </summary>
    public WindowSample? Current => _tracker.Current;

    /// <summary>Whether UI Automation works on this machine.</summary>
    public bool UrlReadingDisabled => _urls.Disabled;

    /// <summary>Called every second. Returns any record that was closed.</summary>
    public IReadOnlyList<AppUsageRecord> Tick(DateTimeOffset now, SegmentState state)
    {
        /**
         * <b>R22a:</b> the window is read in IDLE too (the only clue for recognising meetings), but
         * <b>not in LOCKED</b>: with the screen locked there is nothing in front to read, and there
         * is no reason to read the screen of someone who locked it and walked away.
         *
         * Careful, on cost: in idle the window does not change, so <see cref="ReadUrlIfChanged"/>
         * returns the cached value and the expensive UI Automation call does not happen.
         */
        if (state == SegmentState.Locked) return _tracker.Observe(null, now, state);

        var sample = _probe.Read(ReadUrlIfChanged);

        return _tracker.Observe(sample, now, state);
    }

    public IReadOnlyList<AppUsageRecord> CloseAll(DateTimeOffset now) => _tracker.CloseAll(now);

    /// <summary>
    /// Read again if the window or title changed, otherwise return the previous value.
    ///
    /// Careful: the title is read again here (the probe reads it too), because this is called as a
    /// callback from inside the probe, when its title is not yet available. Calling
    /// <c>GetWindowText</c> twice is cheap; UI Automation is not.
    /// </summary>
    private string? ReadUrlIfChanged(nint hwnd)
    {
        var title = ForegroundWindowProbe.PeekTitle(hwnd);

        if (hwnd == _lastHwnd && string.Equals(title, _lastTitle, StringComparison.Ordinal))
            return _lastUrl;

        _lastHwnd = hwnd;
        _lastTitle = title;
        _lastUrl = _urls.TryRead(hwnd);

        return _lastUrl;
    }
}
