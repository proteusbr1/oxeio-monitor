using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Ui;

/// <summary>The appearances the tray icon can take; there is nothing outside this.</summary>
internal enum TrayVisual
{
    Active,
    Idle,
    Locked,
    Paused,
    Failing,
    Revoked,
}

internal static class TrayVisuals
{
    /// <summary>
    /// Careful: sync health ranks <b>above</b> the state. The news "data is not reaching the
    /// server" is more urgent than "I am idle now"; idleness fixes itself within a minute,
    /// a connection does not.
    ///
    /// <see cref="SyncHealth.Degraded"/> deliberately does not change the icon: if it turned
    /// red ten times a day staff would learn to ignore red itself, and the real J07 would be useless.
    /// </summary>
    public static TrayVisual For(AgentStatus status) => status.Health switch
    {
        SyncHealth.Revoked => TrayVisual.Revoked,
        SyncHealth.Failing => TrayVisual.Failing,
        _ when status.Paused => TrayVisual.Paused,
        _ => status.State switch
        {
            SegmentState.Active => TrayVisual.Active,
            SegmentState.Locked => TrayVisual.Locked,
            _ => TrayVisual.Idle,
        },
    };
}

/// <summary>
/// The icons are drawn in code; there is no <c>.ico</c> binary in the repo.
///
/// Why: a binary file's diff cannot be read, you cannot tell who changed it when, and
/// changing size per DPI would need a new file every time. Here the size is decided at run time.
///
/// Careful: color is not the only difference; each state has its own <b>shape</b>. A red-green
/// difference is invisible to about 8% of men, and in an office of 15 that is almost
/// certainly somebody.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TrayIconPainter : IDisposable
{
    /// <summary>The icon and its HICON together; we have to release both.</summary>
    private readonly record struct Entry(Icon Icon, nint Handle);

    private readonly Dictionary<TrayVisual, Entry> _cache = new();
    private readonly int _size;
    private bool _disposed;

    public TrayIconPainter()
    {
        _size = ResolveSize();
    }

    public int Size => _size;

    /// <summary>Drawn once, then served from the cache.</summary>
    public Icon Get(TrayVisual visual)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        if (_cache.TryGetValue(visual, out var cached)) return cached.Icon;

        var entry = Render(visual, _size);
        _cache[visual] = entry;
        return entry.Icon;
    }

    // ── size ───────────────────────────────────────────────────────────────

    private static int ResolveSize()
    {
        // Careful: the manifest sets PerMonitorV2, so this size comes from the DPI of the
        // primary monitor at process start. If the DPI changes later the shell scales it
        // itself: slightly softer, but better than the risk of building new icons.
        var side = Math.Max(SystemInformation.SmallIconSize.Width,
                            SystemInformation.SmallIconSize.Height);

        if (side < 16) side = 16;
        if (side > 64) side = 64;
        return side;
    }

    // ── drawing ────────────────────────────────────────────────────────────

    private static Entry Render(TrayVisual visual, int size)
    {
        using var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);

        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            var palette = PaletteFor(visual);

            // A little empty space outside, otherwise the anti-aliased edge looks clipped on the taskbar
            var pad = Math.Max(1f, size * 0.07f);
            var body = new RectangleF(pad, pad, size - (2 * pad), size - (2 * pad));

            using (var fill = new SolidBrush(palette.Fill))
            {
                g.FillEllipse(fill, body);
            }

            // Careful: a dark edge is mandatory: a light icon on Windows's light taskbar and a
            // dark icon on the dark taskbar blend in. The inner glyph is always white and the
            // outer ring always dark, so it stands out on both themes.
            using (var edge = new Pen(palette.Edge, Math.Max(1f, size * 0.08f)))
            {
                g.DrawEllipse(edge, body);
            }

            DrawGlyph(g, visual, body, palette.Glyph);
        }

        return FromBitmap(bitmap);
    }

    private readonly record struct Palette(Color Fill, Color Edge, Color Glyph);

    private static Palette PaletteFor(TrayVisual visual) => visual switch
    {
        TrayVisual.Active => new Palette(
            Color.FromArgb(0x2E, 0x9E, 0x4F), Color.FromArgb(0x14, 0x53, 0x2D), Color.White),

        TrayVisual.Idle => new Palette(
            Color.FromArgb(0xC8, 0x8A, 0x12), Color.FromArgb(0x5A, 0x3D, 0x06), Color.White),

        TrayVisual.Locked => new Palette(
            Color.FromArgb(0x5A, 0x64, 0x70), Color.FromArgb(0x26, 0x2C, 0x33), Color.White),

        TrayVisual.Paused => new Palette(
            Color.FromArgb(0x4A, 0x6F, 0xA5), Color.FromArgb(0x1E, 0x2F, 0x49), Color.White),

        TrayVisual.Failing => new Palette(
            Color.FromArgb(0xC6, 0x28, 0x28), Color.FromArgb(0x5A, 0x10, 0x10), Color.White),

        _ => new Palette(
            Color.FromArgb(0x4A, 0x0E, 0x0E), Color.FromArgb(0x1A, 0x04, 0x04), Color.White),
    };

    private static void DrawGlyph(Graphics g, TrayVisual visual, RectangleF body, Color glyph)
    {
        var cx = body.X + (body.Width / 2f);
        var cy = body.Y + (body.Height / 2f);
        var u = body.Width; // 1 unit = the icon's diameter; every size is proportional to it

        using var pen = new Pen(glyph, Math.Max(1.4f, u * 0.13f))
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
        };
        using var brush = new SolidBrush(glyph);

        switch (visual)
        {
            case TrayVisual.Active:
            {
                // ✓
                g.DrawLines(pen, new[]
                {
                    new PointF(cx - (u * 0.22f), cy + (u * 0.02f)),
                    new PointF(cx - (u * 0.06f), cy + (u * 0.17f)),
                    new PointF(cx + (u * 0.23f), cy - (u * 0.19f)),
                });
                break;
            }

            case TrayVisual.Idle:
            {
                // Hollow circle: "running, but nothing is happening"
                var r = u * 0.22f;
                g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
                break;
            }

            case TrayVisual.Paused:
            {
                var w = u * 0.11f;
                var h = u * 0.42f;
                g.FillRectangle(brush, cx - (u * 0.19f), cy - (h / 2), w, h);
                g.FillRectangle(brush, cx + (u * 0.08f), cy - (h / 2), w, h);
                break;
            }

            case TrayVisual.Locked:
            {
                var w = u * 0.40f;
                var h = u * 0.30f;
                g.FillRectangle(brush, cx - (w / 2), cy - (h * 0.05f), w, h);

                using var shackle = new Pen(glyph, Math.Max(1.2f, u * 0.10f));
                g.DrawArc(shackle, cx - (w * 0.30f), cy - (h * 0.95f), w * 0.60f, h * 0.95f, 180f, 180f);
                break;
            }

            case TrayVisual.Failing:
            {
                // ! : you can tell "something is wrong" without seeing the color
                g.FillRectangle(brush, cx - (u * 0.06f), cy - (u * 0.26f), u * 0.12f, u * 0.31f);
                g.FillEllipse(brush, cx - (u * 0.07f), cy + (u * 0.13f), u * 0.14f, u * 0.14f);
                break;
            }

            default:
            {
                // X : canceled
                g.DrawLine(pen, cx - (u * 0.19f), cy - (u * 0.19f), cx + (u * 0.19f), cy + (u * 0.19f));
                g.DrawLine(pen, cx + (u * 0.19f), cy - (u * 0.19f), cx - (u * 0.19f), cy + (u * 0.19f));
                break;
            }
        }
    }

    // ── Bitmap → Icon ──────────────────────────────────────────────────────

    /// <summary>
    /// Careful: <c>Icon.Clone()</c> is <b>not</b> used here, even though it seems the natural
    /// route. An icon created by <c>Icon.FromHandle</c> has no iconData, and in that state
    /// <c>Clone()</c> <b>shares</b> the handle instead of copying it. Destroying the HICON
    /// would then break the clone too, and the symptom would be "the icon suddenly goes blank
    /// after a few hours", which is nearly impossible to debug.
    ///
    /// So both the wrapper and the handle are kept: the wrapper is released in
    /// <see cref="Dispose"/>, the handle in <see cref="TrayNative.DestroyIcon"/>.
    /// </summary>
    private static Entry FromBitmap(Bitmap bitmap)
    {
        var handle = bitmap.GetHicon();
        return new Entry(Icon.FromHandle(handle), handle);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var entry in _cache.Values)
        {
            // Careful: order: the wrapper first, then the handle. And before this method is
            // called, NotifyIcon.Icon = null must already have been set; otherwise the shell
            // will try to draw an HICON that no longer exists.
            entry.Icon.Dispose();
            TrayNative.DestroyIcon(entry.Handle);
        }

        _cache.Clear();
    }
}
