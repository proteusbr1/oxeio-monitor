using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using SkiaSharp;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// BGRA to WebP (ADR-007).
///
/// SkiaSharp was chosen, not ImageSharp: ImageSharp v4+ will not even <b>build</b> without a
/// license file. SkiaSharp is MIT and needs no key.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WebpEncoder
{
    /// <summary>ADR-007: at quality 70 text is clearly readable, and the size is about 150
    /// KB.</summary>
    public const int Quality = 70;

    /// <summary>
    /// Each monitor is scaled down to this width separately.
    /// Careful: a single long image across all monitors is never made: three 4K screens side by
    /// side are 11520 pixels, and squeezing that to 1920 would leave not one character readable.
    /// </summary>
    public const int MaxWidth = 1920;

    /// <summary>A06: this width is enough for the gallery grid.</summary>
    public const int ThumbWidth = 320;

    /// <summary>
    /// Even lower quality for the thumbnail: nobody reads text at 320px, they only see "what kind
    /// of screen". At 50 the file is about 8 KB, and a grid of 200 images loads quickly.
    /// </summary>
    public const int ThumbQuality = 50;

    public static byte[] Encode(CapturedFrame frame)
    {
        var info = new SKImageInfo(
            frame.Width, frame.Height, SKColorType.Bgra8888, SKAlphaType.Opaque);

        var pinned = GCHandle.Alloc(frame.Pixels, GCHandleType.Pinned);
        try
        {
            using var image = SKImage.FromPixels(info, pinned.AddrOfPinnedObject(), frame.Stride);
            using var scaled = Downscale(image, frame.Width, frame.Height);
            using var data = (scaled ?? image).Encode(SKEncodedImageFormat.Webp, Quality);

            return data.ToArray();
        }
        finally
        {
            pinned.Free();
        }
    }

    /// <summary>
    /// A06: a small image for the gallery grid.
    ///
    /// <b>This is done in the agent, not on the server</b>: resizing images in Node on the server
    /// would need <c>sharp</c> (a native binary, a new dependency), while SkiaSharp is already in
    /// the agent. As a bonus, sending 30 KB more saves the server's CPU, and the work of 15 PCs is
    /// spread over the 15 PCs.
    ///
    /// Careful: on failure <c>null</c>, not an exception. <b>Without a thumbnail the gallery shows
    /// the full image</b> (slow, but correct); but the real image must not be lost while making a
    /// thumbnail: the image is what matters.
    /// </summary>
    public static byte[]? EncodeThumb(byte[] webp)
    {
        if (webp is null || webp.Length == 0) return null;

        try
        {
            using var original = SKBitmap.Decode(webp);
            if (original is null || original.Width == 0) return null;

            // if it is already small there is no point encoding again
            if (original.Width <= ThumbWidth) return webp;

            var height = (int)Math.Round(original.Height * (double)ThumbWidth / original.Width);
            var info = new SKImageInfo(ThumbWidth, Math.Max(height, 1));

            using var scaled = original.Resize(info, new SKSamplingOptions(SKCubicResampler.Mitchell));
            if (scaled is null) return null;

            using var image = SKImage.FromBitmap(scaled);
            using var data = image.Encode(SKEncodedImageFormat.Webp, ThumbQuality);

            return data?.ToArray();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return null;
        }
    }

    private static SKImage? Downscale(SKImage image, int width, int height)
    {
        if (width <= MaxWidth) return null;

        var targetHeight = (int)Math.Round(height * (double)MaxWidth / width);
        var info = new SKImageInfo(MaxWidth, targetHeight, SKColorType.Bgra8888, SKAlphaType.Opaque);

        using var surface = SKSurface.Create(info);
        if (surface is null) return null;

        // Mitchell keeps the edges of text, which matters most in screenshots
        var sampling = new SKSamplingOptions(SKCubicResampler.Mitchell);
        surface.Canvas.DrawImage(image, new SKRect(0, 0, MaxWidth, targetHeight), sampling);
        surface.Canvas.Flush();

        return surface.Snapshot();
    }
}
