using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using SkiaSharp;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// <b>G46:</b> a <b>coarse-grained fingerprint</b> of the screen, to tell whether the image has
/// really changed.
///
/// <b>Why it is needed:</b> when a mouse jiggler runs, <c>GetLastInputInfo</c> is fooled and the
/// agent counts "Working" all day. But a jiggler cannot change the screen, so looking at the image
/// catches it.
///
/// Careful: <b>the image is stored nowhere and sent nowhere</b>: only a 256-byte number comes out,
/// and that stays on the machine too. This is unrelated to sending screenshots (that is separate,
/// and the employee knows about it).
///
/// Careful: 16x16 is deliberately <b>very small</b>. A larger one would make even the taskbar clock
/// or cursor flicker count as a "change", and the screen would never freeze, so the safeguard would
/// silently be useless. Such a small fingerprint also holds nothing readable.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class ScreenFingerprint
{
    /// <summary>Cells per side: 16x16 = 256 bytes</summary>
    private const int Side = 16;

    /// <summary>
    /// A fingerprint from a raw BGRA image. <c>null</c> on failure.
    ///
    /// Careful: no exception is thrown. The worst that happens if a fingerprint cannot be made is
    /// that the jiggler is not caught in that sample. And if samples stop arriving,
    /// <see cref="oXeio.Core.Tracking.ScreenActivity.StaleAfter"/> lifts the suspicion after a
    /// while, so a failure does not hurt the employee.
    ///
    /// <b>The path that builds it from WebP was removed</b>, deliberately. Fingerprints built by
    /// two different paths would not be identical (encoding loss), and the comparison would then be
    /// between two kinds of fingerprint: the same scene would show as "changed", and the safeguard
    /// would silently be useless.
    /// </summary>
    public static byte[]? From(CapturedFrame frame)
    {
        if (frame is null || frame.Width == 0 || frame.Height == 0) return null;

        /**
         * Careful: <b>is the buffer really big enough?</b> Without this one line, Skia would go
         * past the array's bounds, which .NET cannot catch: <b>the process would die instantly</b>,
         * with no log. Both capture engines give a tight buffer today, but "gives today" and
         * "always will" are not the same, and if wrong the price is the whole agent.
         */
        if ((long)frame.Stride * frame.Height > frame.Pixels.LongLength) return null;

        try
        {
            var source = new SKImageInfo(
                frame.Width, frame.Height, SKColorType.Bgra8888, SKAlphaType.Opaque);

            /**
             * Careful: the array is <b>pinned</b>. Otherwise the GC could move it exactly while
             * Skia is reading pixels, giving a scrambled fingerprint or an outright crash. The bug
             * would happen rarely and be almost impossible to catch.
             */
            var pin = GCHandle.Alloc(frame.Pixels, GCHandleType.Pinned);
            try
            {
                using var original = new SKBitmap();
                if (!original.InstallPixels(source, pin.AddrOfPinnedObject(), frame.Stride))
                    return null;

                return Shrink(original);
            }
            finally
            {
                pin.Free();
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return null;
        }
    }

    /// <summary>Shrinks a large image to a 16x16 grey fingerprint: one path only, so all
    /// fingerprints are comparable.</summary>
    private static byte[]? Shrink(SKBitmap original)
    {
        /**
         * Converted to grey: colour changes (theme, wallpaper) are not our question; the question
         * is whether the <b>shapes</b> moved.
         *
         * Careful: `Mitchell` is not used, plain averaging is. When shrinking to 16x16 a sharp
         * resampler keeps small details (clock digits), and that is exactly what we do not want.
         */
        var info = new SKImageInfo(Side, Side, SKColorType.Gray8, SKAlphaType.Opaque);
        using var small = original.Resize(info, new SKSamplingOptions(SKFilterMode.Linear));
        if (small is null) return null;

        var pixels = small.GetPixelSpan();
        if (pixels.Length < Side * Side) return null;

        var fingerprint = new byte[Side * Side];
        pixels[..(Side * Side)].CopyTo(fingerprint);
        return fingerprint;
    }
}
