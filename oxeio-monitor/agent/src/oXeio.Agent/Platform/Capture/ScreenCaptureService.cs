using System.Diagnostics;
using System.Runtime.Versioning;

using oXeio.Core.Capture;

namespace oXeio.Agent.Platform.Capture;

internal sealed record CaptureResult(
    int MonitorIndex,
    string DeviceName,
    int Width,
    int Height,
    uint Dpi,
    byte[] Webp,
    FrameQuality.Assessment Quality,
    TimeSpan Elapsed,
    string Engine,
    bool ProtectedContentMasked)
{
    /// <summary>
    /// The image is not usable: either almost entirely one colour, or the OS itself reported that
    /// DRM content was excluded.
    /// </summary>
    public bool Degraded => Quality.Degraded || ProtectedContentMasked;
}

/// <summary>
/// Taking the images of all monitors in one slot.
///
/// A <b>separate</b> image per monitor: they are not stitched together (see WebpEncoder). If one
/// monitor fails the others are still taken.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class ScreenCaptureService(IScreenCapturer capturer) : IDisposable
{
    public string EngineName => capturer.Name;

    /// <summary>
    /// The monitors that gave no image at all in the last attempt.
    ///
    /// Careful: failed monitors used to be dropped silently. So even if one monitor stopped giving
    /// images for good, nobody knew: the others' images kept coming, so everything looked normal.
    /// The mistake would be found only when someone looked for that screen's image and saw it had
    /// never existed.
    /// </summary>
    public IReadOnlyList<string> LastFailedMonitors { get; private set; } = [];

    public IReadOnlyList<CaptureResult> CaptureAll()
    {
        var results = new List<CaptureResult>();
        var failed = new List<string>();

        // Careful: counted afresh each time, so it stays correct across dock/undock
        var monitors = MonitorEnumerator.Enumerate();

        for (var i = 0; i < monitors.Count; i++)
        {
            var sw = Stopwatch.StartNew();
            var frame = capturer.Capture(monitors[i]);

            if (frame is null)
            {
                failed.Add(monitors[i].DeviceName);
                continue;
            }

            var quality = FrameQuality.Assess(frame.Pixels, frame.Width, frame.Height, frame.Stride);
            var webp = WebpEncoder.Encode(frame);
            sw.Stop();

            results.Add(new CaptureResult(
                i, monitors[i].DeviceName, frame.Width, frame.Height,
                monitors[i].Dpi, webp, quality, sw.Elapsed,
                frame.Engine, frame.ProtectedContentMasked));
        }

        LastFailedMonitors = failed;
        return results;
    }

    /// <summary>
    /// <b>G46:</b> the raw image of <b>every</b> monitor, for making the fingerprint.
    ///
    /// Careful: <b>until 31 August 2026 this was <c>CapturePrimary()</c>, only the first screen,
    /// and that is what cut an honest employee's hours in the field.</b> If someone worked on the
    /// second monitor, the first stayed still, so after ten minutes "frozen" and counting stopped.
    /// Measured: on three two-monitor PCs over two days, 43, 9 and 6 false idles, and zero on the
    /// six single-monitor ones.
    ///
    /// The old note feared that <i>"an inactive second monitor would count as frozen and stop
    /// counting"</i>, but that depends on the rule, and the rule is that <b>if any one screen
    /// changed, it counts as changed</b>
    /// (<see cref="oXeio.Core.Tracking.ScreenActivity.DiffersAny"/>).
    ///
    /// Careful: deliberately not <see cref="CaptureAll"/>: that also encodes each one to WebP,
    /// which the fingerprint does not need, and this job runs once a minute (every 5 seconds when
    /// frozen).
    ///
    /// Careful: the images are <b>stored nowhere and sent nowhere</b>: all that comes out is a
    /// 256-byte fingerprint per screen, and that does not leave the machine either.
    /// </summary>
    public IReadOnlyList<CapturedFrame> CaptureEach()
    {
        var monitors = MonitorEnumerator.Enumerate();
        if (monitors.Count == 0) return [];

        var frames = new List<CapturedFrame>(monitors.Count);

        foreach (var monitor in monitors)
        {
            // Careful: if one screen cannot be taken the others still are, otherwise one broken
            // output would blind the whole safeguard.
            var frame = capturer.Capture(monitor);
            if (frame is not null) frames.Add(frame);
        }

        return frames;
    }

    public void Dispose() => capturer.Dispose();
}
