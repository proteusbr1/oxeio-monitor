using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;

using SkiaSharp;

namespace oXeio.Agent.Ui;

/// <summary>
/// WebP file → <see cref="Bitmap"/>, for drawing in a window.
///
/// Why this file exists: <c>Image.FromStream</c> does <b>not</b> understand WebP, because GDI+
/// has no such codec. On failure it says <i>"Parameter is not valid"</i>, which reads as if
/// the file were corrupt. The file is fine; it is the reader that is wrong.
///
/// SkiaSharp is already in the agent (encoding images is its job,
/// <see cref="oXeio.Agent.Platform.Capture.WebpEncoder"/>), so decoding uses it too.
/// No new dependency was added.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WebpImage
{
    /// <summary>
    /// Returns <c>null</c> if it cannot be read, not an exception. Failing to show one preview
    /// is not worth breaking the window.
    /// </summary>
    public static Bitmap? Load(string path)
    {
        try
        {
            var bytes = File.ReadAllBytes(path);

            // Decode <b>without</b> giving a size. This used to pass
            // `new SKImageInfo(0, 0, …)`; Skia took it as "I want a zero-pixel image" and
            // silently returned null, so the window said "could not load preview" even
            // though the file was fine.
            using var decoded = SKBitmap.Decode(bytes);
            if (decoded is null || decoded.Width <= 0 || decoded.Height <= 0) return null;

            // GDI's Format32bppArgb means <b>BGRA</b> in byte order. Depending on the platform
            // Skia may also give Rgba8888; a straight copy would then swap red and blue and the
            // picture would come out bluish.
            if (decoded.ColorType == SKColorType.Bgra8888) return ToBitmap(decoded);

            using var converted = decoded.Copy(SKColorType.Bgra8888);
            return converted is null ? null : ToBitmap(converted);
        }
        catch (Exception e) when (e is IOException
                                      or UnauthorizedAccessException
                                      or ArgumentException
                                      or OutOfMemoryException)
        {
            return null;
        }
    }

    /// <summary>
    /// Copies row by row, not in one go: Skia's <c>RowBytes</c> and GDI's <c>Stride</c> may
    /// differ (GDI aligns each row to 4 bytes). A single copy would skew the image whenever the
    /// width is not a multiple of 4, the classic "picture is slanted" bug.
    /// </summary>
    private static unsafe Bitmap ToBitmap(SKBitmap source)
    {
        var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);

        var locked = bitmap.LockBits(
            new Rectangle(0, 0, source.Width, source.Height),
            ImageLockMode.WriteOnly,
            PixelFormat.Format32bppArgb);

        try
        {
            var src = (byte*)source.GetPixels();
            var dst = (byte*)locked.Scan0;
            var rowBytes = Math.Min(source.RowBytes, Math.Abs(locked.Stride));

            for (var y = 0; y < source.Height; y++)
            {
                Buffer.MemoryCopy(
                    src + ((long)y * source.RowBytes),
                    dst + ((long)y * locked.Stride),
                    rowBytes,
                    rowBytes);
            }
        }
        finally
        {
            bitmap.UnlockBits(locked);
        }

        return bitmap;
    }
}
