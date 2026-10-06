using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// GDI <c>BitBlt</c>: works on every machine, hence the fallback
/// ([ADR-012b](../../../../docs/05-Options-Decisions.md)).
///
/// Limits: hardware-accelerated video, exclusive-fullscreen games and DRM-protected windows may
/// come out black. No attempt is made to prevent it; it is flagged with
/// <see cref="oXeio.Core.Capture.FrameQuality"/>.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class GdiCapturer : IScreenCapturer
{
    private const uint SRCCOPY = 0x00CC0020;

    /// <summary>Without this, layered windows, tooltips and some overlays do not appear in the
    /// image.</summary>
    private const uint CAPTUREBLT = 0x40000000;

    private const uint BI_RGB = 0;
    private const uint DIB_RGB_COLORS = 0;

    public string Name => "GDI";

    public CapturedFrame? Capture(MonitorInfo monitor)
    {
        var w = monitor.Width;
        var h = monitor.Height;
        if (w <= 0 || h <= 0) return null;

        // hWnd = 0 gives the DC of the whole virtual screen. Because PerMonitorV2 is set, it works
        // in physical pixels, not scaled ones.
        var screen = User32.GetDC(0);
        if (screen == 0) return null;

        nint mem = 0, bmp = 0, old = 0;
        try
        {
            mem = Gdi32.CreateCompatibleDC(screen);
            if (mem == 0) return null;

            // Careful: screen DC; with a mem DC we would get a 1-bpp black and white bitmap
            bmp = Gdi32.CreateCompatibleBitmap(screen, w, h);
            if (bmp == 0) return null;

            old = Gdi32.SelectObject(mem, bmp);

            // rcMonitor.Left/Top can be negative (a monitor to the left of the primary)
            if (!Gdi32.BitBlt(mem, 0, 0, w, h, screen,
                    monitor.Bounds.Left, monitor.Bounds.Top, SRCCOPY | CAPTUREBLT))
            {
                return null;
            }

            var stride = w * 4;
            var pixels = new byte[stride * h];

            var header = new BITMAPINFOHEADER
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = w,
                biHeight = -h, // negative = top-down, SkiaSharp can take it directly
                biPlanes = 1,
                biBitCount = 32,
                biCompression = BI_RGB,
            };

            var handle = GCHandle.Alloc(pixels, GCHandleType.Pinned);
            try
            {
                var copied = Gdi32.GetDIBits(
                    mem, bmp, 0, (uint)h, handle.AddrOfPinnedObject(), ref header, DIB_RGB_COLORS);

                if (copied == 0) return null;
            }
            finally
            {
                handle.Free();
            }

            return new CapturedFrame(pixels, w, h, stride, monitor, Name);
        }
        finally
        {
            // Careful: every handle must be released. With 288 captures a day x 2-3 monitors, a
            // leak of one each would reach the 10,000-handle limit in about two weeks, and it would
            // happen on the machine that has been running longest, which is the one nobody is
            // looking at.
            if (old != 0) Gdi32.SelectObject(mem, old);
            if (bmp != 0) Gdi32.DeleteObject(bmp);
            if (mem != 0) Gdi32.DeleteDC(mem);
            User32.ReleaseDC(0, screen);
        }
    }

    public void Dispose() { }
}
