namespace oXeio.Core.Capture;

/// <summary>
/// Copies pixel rows from a GPU texture into a tightly packed buffer.
///
/// <b>Why this is a separate class, and why in Core:</b> when the GPU maps a texture, the
/// length of each row (<i>RowPitch</i>) is almost never <c>width x 4</c>; the driver aligns it
/// to 256 or 512 bytes as it likes. For an image 1920 wide the RowPitch may be 7936 rather
/// than 7680. Those extra 256 bytes are garbage.
///
/// Copying straight through without noticing does <b>not crash</b>: each row shifts a little
/// further and the picture comes out slanted. It is not black either, so
/// <see cref="FrameQuality"/> cannot catch it. Slanted pictures would pile up for months.
///
/// There is nothing Win32 here, only moving bytes. So it lives in Core, and all of it can be
/// verified in ordinary unit tests.
/// </summary>
public static class PixelCopy
{
    public const int BytesPerPixel = 4;

    /// <summary>
    /// Takes only the useful part of each row of <paramref name="source"/> and builds a tightly
    /// packed buffer (stride = width x 4).
    /// </summary>
    /// <param name="source">The raw bytes of the mapped texture.</param>
    /// <param name="sourceRowPitch">Bytes per row in the source: <b>must not be assumed equal to width x 4</b>.</param>
    /// <param name="width">The pixels actually needed (ContentSize, not the texture's width).</param>
    /// <param name="height">The rows actually needed.</param>
    /// <returns>A tightly packed BGRA buffer, top-down.</returns>
    /// <exception cref="ArgumentOutOfRangeException">If the size is impossible.</exception>
    /// <exception cref="ArgumentException">The source does not hold the requested rows.</exception>
    public static byte[] ToTightBuffer(
        ReadOnlySpan<byte> source, int sourceRowPitch, int width, int height)
    {
        Validate(sourceRowPitch, width, height);

        var destStride = width * BytesPerPixel;

        // The last row is not guaranteed to hold the whole pitch: a driver may give a buffer
        // without the last row's padding. So the last row is counted with destStride, and the
        // earlier ones with the pitch.
        var needed = ((long)(height - 1) * sourceRowPitch) + destStride;
        if (source.Length < needed)
        {
            throw new ArgumentException(
                $"the source has {source.Length} bytes, but {width}×{height} @ pitch {sourceRowPitch} " +
                $"needs at least {needed} bytes.", nameof(source));
        }

        var dest = new byte[destStride * height];

        for (var y = 0; y < height; y++)
        {
            source.Slice(y * sourceRowPitch, destStride)
                  .CopyTo(dest.AsSpan(y * destStride, destStride));
        }

        return dest;
    }

    /// <summary>
    /// The size the frame pool gave and the content actually in the frame do not match.
    ///
    /// WGC's frame pool is slow to change size: when the monitor resolution changes or a
    /// display is unplugged and replugged, the pool keeps handing out the <b>old, larger</b>
    /// texture for a while, with the real picture in one corner. The rest is undefined data:
    /// leftovers of the previous frame, or plain garbage.
    ///
    /// So the smaller one is always taken. Taking the larger would attach pieces of the
    /// previous frame to the right and bottom of the picture, which looks much like a genuine
    /// screenshot.
    /// </summary>
    public static (int Width, int Height) ContentBounds(
        int textureWidth, int textureHeight, int contentWidth, int contentHeight)
    {
        var w = Math.Min(textureWidth, contentWidth);
        var h = Math.Min(textureHeight, contentHeight);

        return (Math.Max(0, w), Math.Max(0, h));
    }

    /// <summary>
    /// Straightens the picture of a rotated display.
    ///
    /// <b>Why needed:</b> when a monitor is rotated to portrait, the GPU still scans out in
    /// the panel's own (landscape) orientation, with the image rotated inside. Desktop
    /// duplication hands out that scan-out surface, i.e. a sideways picture.
    ///
    /// Without this, a rotated monitor would fall back to GDI, and video playing on that screen
    /// would come out black, although DXGI was chosen precisely for video.
    /// </summary>
    /// <param name="bgra">Tightly packed BGRA, top-down.</param>
    /// <param name="quarterTurnsClockwise">0 to 3. For 0 the source itself is returned.</param>
    public static (byte[] Pixels, int Width, int Height) RotateClockwise(
        byte[] bgra, int width, int height, int quarterTurnsClockwise)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(width);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(height);

        var turns = ((quarterTurnsClockwise % 4) + 4) % 4;
        if (turns == 0) return (bgra, width, height);

        var swap = turns is 1 or 3;
        var newW = swap ? height : width;
        var newH = swap ? width : height;

        var dest = new byte[newW * newH * BytesPerPixel];

        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var (nx, ny) = turns switch
                {
                    1 => (height - 1 - y, x),
                    2 => (width - 1 - x, height - 1 - y),
                    _ => (y, width - 1 - x),
                };

                var src = ((y * width) + x) * BytesPerPixel;
                var dst = ((ny * newW) + nx) * BytesPerPixel;

                dest[dst] = bgra[src];
                dest[dst + 1] = bgra[src + 1];
                dest[dst + 2] = bgra[src + 2];
                dest[dst + 3] = bgra[src + 3];
            }
        }

        return (dest, newW, newH);
    }

    /// <summary>
    /// <c>DXGI_MODE_ROTATION</c> → how many turns to rotate.
    ///
    /// There is no doubt about 180 degrees, but <b>which of 90 and 270 goes which way has not
    /// been verified on a real rotated monitor</b>. If reversed, the picture will lean the
    /// wrong way, but that will be noticed; it will not hide like a black picture.
    /// </summary>
    public static int TurnsForRotation(uint dxgiModeRotation) => dxgiModeRotation switch
    {
        2 => 1, // ROTATE90
        3 => 2, // ROTATE180
        4 => 3, // ROTATE270
        _ => 0, // UNSPECIFIED / IDENTITY
    };

    private static void Validate(int rowPitch, int width, int height)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(width);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(height);
        ArgumentOutOfRangeException.ThrowIfLessThan(rowPitch, width * BytesPerPixel);
    }
}
