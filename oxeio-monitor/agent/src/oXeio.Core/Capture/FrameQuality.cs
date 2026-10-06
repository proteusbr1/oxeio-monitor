namespace oXeio.Core.Capture;

/// <summary>
/// Does the picture actually show something, or is it entirely black?
///
/// <b>Why this is the most useful reliability feature:</b> DRM-protected windows,
/// hardware-accelerated video, banking portals, or Teams' "prevent capture" all come out black
/// in <b>any</b> capture API. That cannot be told apart from "the staff member's screen really
/// was black".
///
/// Unless flagged, black pictures would pile up for months and nobody would notice. This is
/// not an attempt to <b>prevent</b> it: that is the limit of the OS's content protection, and
/// getting around it in a staff-monitoring tool would be ethically wrong. It only <i>makes it known</i>.
/// </summary>
public static class FrameQuality
{
    /// <summary>One sample per this many pixels: there is no need to read all of them.</summary>
    public const int SampleStride = 64;

    /// <summary>If more than this share is black, the picture is not useful.</summary>
    public const double BlackThreshold = 0.99;

    /// <summary>If more than this share is one color (even if not black), it is suspicious.</summary>
    public const double UniformThreshold = 0.99;

    public readonly record struct Assessment(
        double BlackRatio,
        double UniformRatio,
        bool Degraded)
    {
        public string? Reason => !Degraded ? null
            : BlackRatio >= BlackThreshold ? "almost entirely black"
            : "almost entirely one colour";
    }

    /// <param name="bgra">BGRA 8-bit, top-down.</param>
    /// <param name="width">In pixels.</param>
    /// <param name="height">In pixels.</param>
    /// <param name="stride">Bytes per row (including padding).</param>
    public static Assessment Assess(ReadOnlySpan<byte> bgra, int width, int height, int stride)
    {
        if (width <= 0 || height <= 0 || bgra.IsEmpty)
            return new Assessment(1, 1, true);

        var sampled = 0;
        var black = 0;
        uint? first = null;
        var uniform = 0;

        for (var y = 0; y < height; y += SampleStride)
        {
            var row = y * stride;
            for (var x = 0; x < width; x += SampleStride)
            {
                var i = row + (x * 4);
                if (i + 3 >= bgra.Length) continue;

                var b = bgra[i];
                var g = bgra[i + 1];
                var r = bgra[i + 2];

                sampled++;
                if (b == 0 && g == 0 && r == 0) black++;

                var packed = (uint)((r << 16) | (g << 8) | b);
                first ??= packed;
                if (packed == first) uniform++;
            }
        }

        if (sampled == 0) return new Assessment(1, 1, true);

        var blackRatio = (double)black / sampled;
        var uniformRatio = (double)uniform / sampled;

        return new Assessment(
            blackRatio,
            uniformRatio,
            blackRatio >= BlackThreshold || uniformRatio >= UniformThreshold);
    }
}
