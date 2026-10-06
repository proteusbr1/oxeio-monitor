using oXeio.Core.Capture;

namespace oXeio.Core.Tests;

public class FrameQualityTests
{
    private const int W = 512;
    private const int H = 256;
    private const int Stride = W * 4;

    private static byte[] Filled(byte b, byte g, byte r)
    {
        var buf = new byte[Stride * H];
        for (var i = 0; i < buf.Length; i += 4)
        {
            buf[i] = b;
            buf[i + 1] = g;
            buf[i + 2] = r;
            buf[i + 3] = 255;
        }
        return buf;
    }

    /// <summary>Every pixel is different, like a real desktop.</summary>
    private static byte[] Noisy()
    {
        var buf = new byte[Stride * H];
        var rng = new Random(42);
        rng.NextBytes(buf);
        return buf;
    }

    [Fact]
    public void A_fully_black_frame_is_flagged()
    {
        var a = FrameQuality.Assess(Filled(0, 0, 0), W, H, Stride);

        Assert.True(a.Degraded);
        Assert.Equal(1.0, a.BlackRatio);
        Assert.Equal("almost entirely black", a.Reason);
    }

    [Fact]
    public void A_single_colour_frame_is_flagged_too()
    {
        // A DRM-protected window is not always black; sometimes it comes out white or gray
        var a = FrameQuality.Assess(Filled(255, 255, 255), W, H, Stride);

        Assert.True(a.Degraded);
        Assert.Equal(0, a.BlackRatio);
        Assert.Equal("almost entirely one colour", a.Reason);
    }

    [Fact]
    public void A_normal_desktop_frame_is_accepted()
    {
        var a = FrameQuality.Assess(Noisy(), W, H, Stride);

        Assert.False(a.Degraded);
        Assert.Null(a.Reason);
        Assert.True(a.BlackRatio < 0.5);
    }

    [Fact]
    public void An_empty_buffer_counts_as_degraded()
    {
        var a = FrameQuality.Assess(ReadOnlySpan<byte>.Empty, W, H, Stride);
        Assert.True(a.Degraded);
    }

    [Fact]
    public void A_zero_size_counts_as_degraded()
    {
        Assert.True(FrameQuality.Assess(Filled(1, 2, 3), 0, 0, 0).Degraded);
    }

    /// <summary>
    /// One monitor black and the rest normal: such a mixed image must not wrongly be
    /// called "fine". If half is black it does not cross the threshold, and that is
    /// desired: each monitor's image is checked separately.
    /// </summary>
    [Fact]
    public void A_half_black_frame_is_not_flagged()
    {
        var buf = Noisy();
        Array.Clear(buf, 0, buf.Length / 2);

        var a = FrameQuality.Assess(buf, W, H, Stride);

        Assert.InRange(a.BlackRatio, 0.4, 0.6);
        Assert.False(a.Degraded);
    }
}
