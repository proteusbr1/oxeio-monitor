using System.Drawing;
using System.Runtime.Versioning;

namespace oXeio.Agent.Ui;

internal enum TrayFontRole
{
    /// <summary>Ordinary text.</summary>
    Body,

    /// <summary>Headings and important lines.</summary>
    Strong,

    /// <summary>Today's hours: the largest number in the window.</summary>
    Big,

    /// <summary>Footnotes and explanations.</summary>
    Small,

    /// <summary>
    /// The hero number: how many hours have been counted today. Larger than <see cref="Big"/>
    /// and lighter: 44px semibold. Careful: at 44px bold the number shouted, and this window's
    /// job is to reassure, not to make claims.
    /// </summary>
    Hero,

    /// <summary>
    /// The <b>seconds part</b> of the hero number: exactly half of <see cref="Hero"/> (22px).
    ///
    /// The owner asked for this (18 August): the <c>:22</c> of <c>3:59:22</c> at half size.
    /// The reason goes beyond decoration: seconds are the only digits that change
    /// <b>every second</b>, and at full size they kept drawing the eye, while the figures that
    /// matter for work are hours and minutes. Made smaller, the movement remains (you can see
    /// the clock running) but it no longer shouts.
    /// Careful: the family and style are <see cref="Hero"/>'s own; otherwise the two numbers
    /// would look like they came from two families, and the baseline alignment would break.
    /// </summary>
    HeroSeconds,

    /// <summary>The small uppercase labels of the readout (SYNC · LAST SYNC · QUEUED).</summary>
    Micro,

    /// <summary>
    /// Numbers and clock readouts. Careful: a separate family (Cascadia Mono), as the web's
    /// <c>--font-mono</c> says. When equal-width digits sit side by side the eye can compare
    /// them; in a proportional font "11:11" and "19:40" would have different widths.
    /// </summary>
    Mono,
}

/// <summary>
/// Window text fonts, cached per DPI.
///
/// Careful: a font is a GDI handle. Writing <c>new Font(...)</c> in every <c>OnPaint</c>
/// looks harmless (the GC exists), but a thousand handles can pile up before the finalizer
/// runs, and that is what happens when someone works all day with this window open.
/// So fonts are cached per (role, DPI) pair. The number of pairs is limited: 4 roles x a
/// handful of DPIs.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TrayFonts : IDisposable
{
    /// <summary>
    /// Fonts in order of preference. Segoe UI is Windows's own UI font, present in every
    /// version since Vista, long before our minimum target of Windows 10 1809.
    /// The other two are just a safety net in case someone uninstalls the system font.
    ///
    /// Careful: this used to list "Nirmala UI"/"Shonar Bangla"/"Vrinda" first, because the
    /// text was in Bengali. Now that all text on screen is English, that list is not just
    /// unnecessary but harmful: Nirmala UI is made for Indic scripts, its Latin metrics are
    /// unlike Segoe UI's, and next to the rest of Windows's UI the window looked out of place.
    /// </summary>
    private static readonly string[] Candidates =
    [
        "Segoe UI", "Tahoma", "Arial",
    ];

    /// <summary>
    /// The equal-width font for readouts, the same as the web's <c>--font-mono</c>.
    /// Cascadia Mono exists on Windows 11, and Consolas has been there since Vista.
    /// </summary>
    private static readonly string[] MonoCandidates =
    [
        "Cascadia Mono", "Consolas", "Courier New",
    ];

    /// <summary>
    /// Careful: semibold is a <b>separate family</b> on Windows, not a style: giving
    /// <c>FontStyle.Bold</c> to "Segoe UI" gives weight 700, not 600. If it is not found,
    /// <see cref="TrayFontRole.Hero"/> falls back to bold.
    /// </summary>
    private const string SemiboldFamily = "Segoe UI Semibold";

    private readonly Dictionary<(TrayFontRole Role, int Dpi), Font> _cache = new();
    private readonly string _family;
    private readonly string _mono;
    private readonly string? _semibold;
    private bool _disposed;

    public TrayFonts()
    {
        _family = PickFamily();
        _mono = PickFrom(MonoCandidates) ?? _family;
        _semibold = Exists(SemiboldFamily) ? SemiboldFamily : null;
    }

    public string FamilyName => _family;

    public Font Get(TrayFontRole role, int dpi)
    {
        if (dpi < 72) dpi = 96;
        if (dpi > 480) dpi = 480;

        var key = (role, dpi);
        if (_cache.TryGetValue(key, out var cached)) return cached;

        // Careful: size is in pixels, not points. In a PerMonitorV2 process WinForms does not
        // rescale fonts itself, so point-based fonts would stay exactly as small on a 150%
        // monitor as at 100%, while the window grew larger.
        var px = BasePixels(role) * dpi / 96f;

        // Hero uses the semibold family if found, otherwise bold; if neither is found it should
        // at least look heavy, or the hero number would look like body text.
        var family = role switch
        {
            TrayFontRole.Mono => _mono,
            TrayFontRole.Hero or TrayFontRole.HeroSeconds => _semibold ?? _family,
            _ => _family,
        };

        var style = role switch
        {
            TrayFontRole.Strong or TrayFontRole.Big => FontStyle.Bold,
            TrayFontRole.Hero or TrayFontRole.HeroSeconds =>
                _semibold is null ? FontStyle.Bold : FontStyle.Regular,
            _ => FontStyle.Regular,
        };

        var font = new Font(family, px, style, GraphicsUnit.Pixel);
        _cache[key] = font;
        return font;
    }

    private static float BasePixels(TrayFontRole role) => role switch
    {
        TrayFontRole.Hero => 44f,
        // Careful: exactly half, not a hand-set number; if the hero's size changes the
        // seconds follow automatically
        TrayFontRole.HeroSeconds => 44f / 2f,
        TrayFontRole.Big => 30f,
        TrayFontRole.Strong => 16f,
        TrayFontRole.Mono => 13f,
        TrayFontRole.Small => 12f,
        TrayFontRole.Micro => 10.5f,
        _ => 14f,
    };

    /// <summary>
    /// <see cref="ArgumentException"/> if not installed. This is the only reliable test,
    /// because <c>new Font(...)</c> silently falls back when given an unknown name, so the
    /// mistake would only be caught on screen, in no log.
    /// </summary>
    private static bool Exists(string family)
    {
        try
        {
            using var probe = new FontFamily(family);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static string? PickFrom(string[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (Exists(candidate)) return candidate;
        }

        return null;
    }

    private static string PickFamily()
    {
        if (PickFrom(Candidates) is { } found) return found;

        try
        {
            using var messageBox = SystemFonts.MessageBoxFont;
            if (messageBox is not null) return messageBox.Name;
        }
        catch (Exception)
        {
        }

        return "Segoe UI";
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var font in _cache.Values) font.Dispose();
        _cache.Clear();
    }
}
