using System.Drawing;
using System.Runtime.Versioning;

namespace oXeio.Agent.Ui;

/// <summary>
/// Colors of the tray window: an exact pairing with the tokens in <c>web/src/index.css</c>.
///
/// <b>Why this file was needed:</b> the window used to be drawn with
/// <see cref="SystemColors"/>: <c>Window</c>, <c>WindowText</c>, <c>GrayText</c>,
/// <c>ControlLight</c>. So the window wore whatever Windows was wearing and carried no oXeio
/// identity of its own, even though it is the one screen every employee sees every day.
///
/// Careful: the values here are <b>hand-written constants</b>, because the CSS file does not
/// come into the agent's build. If a color is changed there it must be changed here too,
/// which is why the token name is written next to each one.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed record TrayTheme
{
    /// <summary><c>--color-surface</c>: the window background.</summary>
    public required Color Surface { get; init; }

    /// <summary><c>--color-line</c>: hairlines and borders.</summary>
    public required Color Line { get; init; }

    /// <summary><c>--color-ink</c>: main text and the fill of the current progress.</summary>
    public required Color Ink { get; init; }

    /// <summary><c>--color-ink-2</c>: labels.</summary>
    public required Color Ink2 { get; init; }

    /// <summary><c>--color-ink-3</c>: footnotes and inactive dots.</summary>
    public required Color Ink3 { get; init; }

    /// <summary>
    /// <c>--color-brand</c>. Careful: in this window red is <b>only for a real problem</b>:
    /// "data is not reaching the server". Being behind is not an incident; that is
    /// <see cref="Idle"/> amber.
    /// </summary>
    public required Color Brand { get; init; }

    /// <summary><c>--color-ok</c>: work is running, and the monthly target is met.</summary>
    public required Color Ok { get; init; }

    /// <summary><c>--color-idle</c>: paused, and "behind".</summary>
    public required Color Idle { get; init; }

    /// <summary>The empty part of a meter (<c>--track</c>).</summary>
    public required Color Track { get; init; }

    /// <summary>The default: the dashboard's Midnight.</summary>
    public static TrayTheme Midnight { get; } = new()
    {
        Surface = Rgb(0x16, 0x1B, 0x22),
        Line = Rgb(0x24, 0x2B, 0x35),
        Ink = Rgb(0xE8, 0xEC, 0xF1),
        Ink2 = Rgb(0xA6, 0xB0, 0xBD),
        Ink3 = Rgb(0x6E, 0x78, 0x85),
        Brand = Rgb(0xFF, 0x4D, 0x54),
        Ok = Rgb(0x3F, 0xB9, 0x50),
        Idle = Rgb(0xD9, 0xA4, 0x06),
        Track = Rgb(0x24, 0x2B, 0x35),
    };

    /// <summary>The light theme, for when Windows is in light mode.</summary>
    public static TrayTheme Day { get; } = new()
    {
        Surface = Rgb(0xFF, 0xFF, 0xFF),
        Line = Rgb(0xE4, 0xE6, 0xEA),
        Ink = Rgb(0x14, 0x17, 0x1C),
        Ink2 = Rgb(0x4E, 0x56, 0x61),
        Ink3 = Rgb(0x8B, 0x93, 0xA0),
        Brand = Rgb(0xED, 0x1C, 0x24),
        Ok = Rgb(0x1F, 0x9D, 0x55),
        Idle = Rgb(0xB8, 0x86, 0x0B),
        Track = Rgb(0xE4, 0xE6, 0xEA),
    };

    /// <summary>
    /// What the window wears: <b>always Midnight</b>.
    ///
    /// The owner's decision (11 August): even when Windows is in light mode the window carries
    /// the product's own identity, not the OS's. The dashboard does the same:
    /// <c>color-scheme: dark</c> in <c>index.css</c>, not <c>light dark</c>.
    /// With two different looks on the two screens, staff would see them as two different things.
    ///
    /// Careful: <see cref="Day"/> was not removed: its colors were chosen to match the
    /// dashboard's light theme, and both are drawn in the mockup. If a theme switch ever
    /// comes to settings it will be needed, and the colors will not have to be chosen again.
    /// </summary>
    public static TrayTheme Current => Midnight;

    private static Color Rgb(int r, int g, int b) => Color.FromArgb(r, g, b);
}
