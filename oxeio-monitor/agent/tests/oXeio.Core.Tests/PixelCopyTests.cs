using oXeio.Core.Capture;

namespace oXeio.Core.Tests;

public class PixelCopyTests
{
    /// <summary>
    /// Writes each pixel's row and column into it, so after the copy you can check by
    /// eye where each pixel went. Even a one-byte shift is caught.
    /// </summary>
    private static byte[] Grid(int rowPitch, int width, int height, byte tag = 0xEE)
    {
        var buf = new byte[rowPitch * height];
        Array.Fill(buf, tag); // recognizable junk in the padding

        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var i = (y * rowPitch) + (x * 4);
                buf[i] = (byte)x;      // B = column
                buf[i + 1] = (byte)y;  // G = row
                buf[i + 2] = 0x10;
                buf[i + 3] = 0xFF;
            }
        }

        return buf;
    }

    [Fact]
    public void Pitch_আর_প্রস্থ_সমান_হলে_হুবহু_কপি_হয়()
    {
        const int w = 8, h = 4;
        var src = Grid(w * 4, w, h);

        var dest = PixelCopy.ToTightBuffer(src, w * 4, w, h);

        Assert.Equal(src, dest);
    }

    [Fact]
    public void Pitch_বড়_হলে_padding_বাদ_যায়_আর_সারি_সরে_না()
    {
        const int w = 8, h = 4;
        const int pitch = (w * 4) + 64; // the driver's extra 64 bytes
        var src = Grid(pitch, w, h);

        var dest = PixelCopy.ToTightBuffer(src, pitch, w, h);

        Assert.Equal(w * 4 * h, dest.Length);

        for (var y = 0; y < h; y++)
        {
            for (var x = 0; x < w; x++)
            {
                var i = (y * w * 4) + (x * 4);
                Assert.Equal((byte)x, dest[i]);      // column is right
                Assert.Equal((byte)y, dest[i + 1]);  // row is right
            }
        }

        // none of the padding junk got in
        Assert.DoesNotContain((byte)0xEE, dest);
    }

    /// <summary>
    /// This is the most dangerous bug: if the pitch is ignored and the copy is done in
    /// one run, the image does not crash and is not black; each row just shifts a little
    /// further and the picture becomes slanted. This test shows what would happen on the wrong
    /// path.
    /// </summary>
    [Fact]
    public void টানা_কপি_করলে_ছবি_তেরছা_হতো()
    {
        const int w = 8, h = 4;
        const int pitch = (w * 4) + 64;
        var src = Grid(pitch, w, h);

        var correct = PixelCopy.ToTightBuffer(src, pitch, w, h);
        var naive = src.AsSpan(0, w * 4 * h).ToArray(); // forgetting the pitch

        Assert.NotEqual(correct, naive);

        // the first pixel of row two in naive came from the padding of row one
        Assert.Equal(0xEE, naive[w * 4]);
        Assert.Equal(0x00, correct[w * 4]); // real: column 0
    }

    [Fact]
    public void শেষ_সারির_padding_না_থাকলেও_চলে()
    {
        // the driver may give no padding after the last row
        const int w = 8, h = 4;
        const int pitch = (w * 4) + 64;
        var full = Grid(pitch, w, h);
        var clipped = full.AsSpan(0, ((h - 1) * pitch) + (w * 4)).ToArray();

        var dest = PixelCopy.ToTightBuffer(clipped, pitch, w, h);

        Assert.Equal(w * 4 * h, dest.Length);
        Assert.Equal((byte)(h - 1), dest[((h - 1) * w * 4) + 1]); // the last row came through right
    }

    [Fact]
    public void উৎস_ছোট_হলে_চুপচাপ_আবর্জনা_না_দিয়ে_থেমে_যায়()
    {
        const int w = 8, h = 4;
        const int pitch = w * 4;
        var tooSmall = new byte[pitch * (h - 1)];

        Assert.Throws<ArgumentException>(
            () => PixelCopy.ToTightBuffer(tooSmall, pitch, w, h));
    }

    [Theory]
    [InlineData(0, 4)]
    [InlineData(4, 0)]
    [InlineData(-1, 4)]
    public void অসম্ভব_মাপ_নাকচ_হয়(int w, int h)
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => PixelCopy.ToTightBuffer(new byte[1024], 4096, w, h));
    }

    [Fact]
    public void Pitch_প্রস্থের_চেয়ে_ছোট_হলে_নাকচ()
    {
        // a pitch smaller than width x 4 means the calculation is wrong somewhere; not something
        // to accept quietly
        Assert.Throws<ArgumentOutOfRangeException>(
            () => PixelCopy.ToTightBuffer(new byte[1024], 16, 8, 4));
    }

    // ── ContentBounds ───────────────────────────────────────────────────────

    [Fact]
    public void পুল_বড়_হলে_কনটেন্টের_মাপই_নেওয়া_হয়()
    {
        // after the monitor is lowered to 1920x1080 the pool keeps returning 2560x1440 for a while
        var (w, h) = PixelCopy.ContentBounds(2560, 1440, 1920, 1080);

        Assert.Equal(1920, w);
        Assert.Equal(1080, h);
    }

    [Fact]
    public void কনটেন্ট_বড়_দেখালেও_টেক্সচারের_বাইরে_যাওয়া_হয়_না()
    {
        // the opposite direction must be prevented too; otherwise it would fall outside the texture
        var (w, h) = PixelCopy.ContentBounds(1920, 1080, 2560, 1440);

        Assert.Equal(1920, w);
        Assert.Equal(1080, h);
    }

    [Fact]
    public void মাপ_মিলে_গেলে_সেটাই_ফেরে()
    {
        var (w, h) = PixelCopy.ContentBounds(1920, 1080, 1920, 1080);

        Assert.Equal(1920, w);
        Assert.Equal(1080, h);
    }

    [Fact]
    public void ঋণাত্মক_মাপ_শূন্যে_আটকায়()
    {
        var (w, h) = PixelCopy.ContentBounds(1920, 1080, -1, -1);

        Assert.Equal(0, w);
        Assert.Equal(0, h);
    }

    // ── rotation ────────────────────────────────────────────────────────────

    /// <summary>
    /// B = column, G = row in every pixel; after rotating you can see who went where.
    /// </summary>
    private static byte[] Tagged(int w, int h)
    {
        var buf = new byte[w * h * 4];
        for (var y = 0; y < h; y++)
        {
            for (var x = 0; x < w; x++)
            {
                var i = ((y * w) + x) * 4;
                buf[i] = (byte)x;
                buf[i + 1] = (byte)y;
                buf[i + 2] = 0x20;
                buf[i + 3] = 0xFF;
            }
        }
        return buf;
    }

    private static (byte B, byte G) At(byte[] buf, int w, int x, int y)
    {
        var i = ((y * w) + x) * 4;
        return (buf[i], buf[i + 1]);
    }

    [Fact]
    public void শূন্য_পাকে_উৎসই_ফেরে()
    {
        var src = Tagged(4, 3);
        var (dst, w, h) = PixelCopy.RotateClockwise(src, 4, 3, 0);

        Assert.Same(src, dst);
        Assert.Equal(4, w);
        Assert.Equal(3, h);
    }

    [Fact]
    public void নব্বই_ডিগ্রিতে_মাপ_উল্টে_যায়_আর_কোণা_ঠিক_জায়গায়_বসে()
    {
        var src = Tagged(4, 3);
        var (dst, w, h) = PixelCopy.RotateClockwise(src, 4, 3, 1);

        Assert.Equal(3, w);
        Assert.Equal(4, h);

        // 90° clockwise: the source's top-left corner (0,0) goes to the top-right
        Assert.Equal((0, 0), At(dst, w, 2, 0));
        // the source's top-right corner (3,0) goes to the bottom-right
        Assert.Equal((3, 0), At(dst, w, 2, 3));
        // the source's bottom-left corner (0,2) goes to the top-left
        Assert.Equal((0, 2), At(dst, w, 0, 0));
    }

    [Fact]
    public void একশো_আশি_ডিগ্রিতে_মাপ_একই_থাকে_ছবি_উল্টে_যায়()
    {
        var src = Tagged(4, 3);
        var (dst, w, h) = PixelCopy.RotateClockwise(src, 4, 3, 2);

        Assert.Equal(4, w);
        Assert.Equal(3, h);
        Assert.Equal((0, 0), At(dst, w, 3, 2)); // top-left → bottom-right
        Assert.Equal((3, 2), At(dst, w, 0, 0)); // bottom-right → top-left
    }

    [Fact]
    public void চার_পাক_ঘোরালে_আবার_আগের_জায়গায়()
    {
        // the best test of rotation: applying it four times, a full circle, leaves the result
        // unchanged
        var src = Tagged(5, 3);
        var cur = (Pixels: src, Width: 5, Height: 3);

        for (var i = 0; i < 4; i++)
            cur = PixelCopy.RotateClockwise(cur.Pixels, cur.Width, cur.Height, 1);

        Assert.Equal(5, cur.Width);
        Assert.Equal(3, cur.Height);
        Assert.Equal(src, cur.Pixels);
    }

    [Fact]
    public void নব্বই_দুবার_আর_একশো_আশি_একবার_একই_ফল()
    {
        var src = Tagged(4, 3);

        var twice = PixelCopy.RotateClockwise(src, 4, 3, 1);
        twice = PixelCopy.RotateClockwise(twice.Pixels, twice.Width, twice.Height, 1);

        var once = PixelCopy.RotateClockwise(src, 4, 3, 2);

        Assert.Equal(once.Pixels, twice.Pixels);
        Assert.Equal(once.Width, twice.Width);
    }

    [Theory]
    [InlineData(0u, 0)] // UNSPECIFIED
    [InlineData(1u, 0)] // IDENTITY
    [InlineData(2u, 1)] // ROTATE90
    [InlineData(3u, 2)] // ROTATE180
    [InlineData(4u, 3)] // ROTATE270
    public void DXGI_ঘূর্ণন_কোড_ঠিকভাবে_পাকে_রূপান্তরিত_হয়(uint rotation, int turns)
    {
        Assert.Equal(turns, PixelCopy.TurnsForRotation(rotation));
    }

    [Fact]
    public void অচেনা_ঘূর্ণন_কোডে_ঘোরানো_হয়_না()
    {
        // given an unknown value, not rotating is safer than rotating by a guess
        Assert.Equal(0, PixelCopy.TurnsForRotation(99));
    }
}
