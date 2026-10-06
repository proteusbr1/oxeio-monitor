using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Ui;

namespace oXeio.Agent.Tests;

/// <summary>
/// <b>The seconds part of the hero number, at half size.</b>
///
/// The owner wants the <c>:22</c> of <c>3:59:22</c> at half size. Careful: "made it
/// smaller" is not the same as "looks right". If the small text drifts up or down off
/// the baseline, it looks broken, and no compiler catches that.
///
/// So this really draws and **counts pixels**: it draws onto a bitmap, then measures
/// where the ink landed to find how tall the text is and where its bottom is. No GUI
/// needs to open, so it also runs in CI.
/// </summary>
[SupportedOSPlatform("windows")]
public class HeroSecondsTests
{
    // ── pure rules ──────────────────────────────────────────────────────────

    /// <summary>
    /// Careful: the <b>last</b> colon, not the first; using the first would shrink the minutes too.
    /// </summary>
    [Theory]
    [InlineData("3:59:22", "3:59", ":22")]
    [InlineData("0:00:07", "0:00", ":07")]
    [InlineData("123:45:06", "123:45", ":06")]
    public void SplitsAtTheSecondsColon(string figure, string head, string tail)
    {
        Assert.Equal((head, tail), UiText.SplitSeconds(figure));
    }

    /// <summary>
    /// Careful: with no seconds the tail is empty, so everything is drawn at hero size,
    /// not half. (So that if <c>Duration()</c> is ever put in the hero, the minutes
    /// do not silently shrink.)
    /// </summary>
    [Theory]
    [InlineData("3:59")]
    [InlineData("")]
    [InlineData("59")]
    public void LeavesTheTailEmptyWhenThereAreNoSeconds(string figure)
    {
        Assert.Equal(string.Empty, UiText.SplitSeconds(figure).Tail);
    }

    // ── drawing ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Exactly half: not a hand-set number, so when the hero size changes the seconds
    /// follow.
    /// </summary>
    [Fact]
    public void SecondsFontIsExactlyHalfTheHero()
    {
        using var fonts = new TrayFonts();

        var hero = fonts.Get(TrayFontRole.Hero, 96);
        var seconds = fonts.Get(TrayFontRole.HeroSeconds, 96);

        Assert.Equal(hero.Size / 2f, seconds.Size, 3);
        // Careful: same family and style, otherwise the two digit groups would look
        // like two families and the baseline alignment calculation would fall apart
        Assert.Equal(hero.FontFamily.Name, seconds.FontFamily.Name);
        Assert.Equal(hero.Style, seconds.Style);
    }

    /// <summary>
    /// Careful: the ratio is the same at 150% DPI too, because fonts are built in pixels
    /// and both grow together.
    /// </summary>
    [Fact]
    public void TheHalfHoldsAtHighDpi()
    {
        using var fonts = new TrayFonts();

        var hero = fonts.Get(TrayFontRole.Hero, 144);
        var seconds = fonts.Get(TrayFontRole.HeroSeconds, 144);

        Assert.Equal(hero.Size / 2f, seconds.Size, 3);
    }

    /// <summary>
    /// <b>The real check: measuring ink.</b> The small digits really are about half as
    /// tall, and their <b>bottom</b> lines up with the bottom of the big digits.
    ///
    /// Careful: the second claim is the important one. Shrinking is easy, but if the
    /// small text floats off the baseline the window looks broken, and a floating digit
    /// that moves every second is hard to ignore.
    /// </summary>
    [Fact]
    public void SecondsSitOnTheSameBaselineAtHalfTheHeight()
    {
        using var fonts = new TrayFonts();
        var hero = fonts.Get(TrayFontRole.Hero, 96);
        var seconds = fonts.Get(TrayFontRole.HeroSeconds, 96);

        // Careful: the `OwnerDrawnForm.AscentPx` calculation is not rewritten here.
        // Drawing follows that code's rules, and measuring is done **from the image**.
        // If the two were the same, the test would agree with itself and prove nothing.
        var heroTop = 20;
        var tailTop = heroTop + Ascent(hero) - Ascent(seconds);

        using var canvas = new Bitmap(400, 120, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(canvas))
        {
            g.Clear(Color.Black);

            TextRenderer.DrawText(
                g, "3:59", hero, new Point(10, heroTop), Color.White, Flags);
            TextRenderer.DrawText(
                g, ":22", seconds, new Point(220, tailTop), Color.White, Flags);
        }

        var big = InkRows(canvas, 0, 200);
        var small = InkRows(canvas, 210, 390);

        Assert.True(big.HasValue && small.HasValue, "both should leave ink");

        var bigHeight = big!.Value.Bottom - big.Value.Top;
        var smallHeight = small!.Value.Bottom - small.Value.Top;

        // Careful: not exactly half; the digit size is not exactly proportional to the
        // font size (hinting, rounding). +-20% is loose enough, yet still tight enough
        // to catch "was not made smaller".
        var ratio = (double)smallHeight / bigHeight;
        Assert.InRange(ratio, 0.40, 0.60);

        // The bottoms line up, with 2px slack, because ':' and the digits' lower edges
        // do not end on exactly the same pixel
        Assert.InRange(Math.Abs(big.Value.Bottom - small.Value.Bottom), 0, 2);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private const TextFormatFlags Flags =
        TextFormatFlags.NoPrefix | TextFormatFlags.WordBreak | TextFormatFlags.NoPadding;

    private static int Ascent(Font font)
    {
        var family = font.FontFamily;

        return (int)Math.Round(
            font.Size * family.GetCellAscent(font.Style) / family.GetEmHeight(font.Style));
    }

    /// <summary>
    /// The row where ink starts and ends within the given columns.
    /// Careful: it is white text on a black background, so "ink" means any non-black pixel.
    /// </summary>
    private static (int Top, int Bottom)? InkRows(Bitmap image, int fromX, int toX)
    {
        int top = -1, bottom = -1;

        for (var y = 0; y < image.Height; y++)
        {
            for (var x = fromX; x < Math.Min(toX, image.Width); x++)
            {
                if (image.GetPixel(x, y).R <= 40) continue;

                if (top < 0) top = y;
                bottom = y;
                break;
            }
        }

        return top < 0 ? null : (top, bottom);
    }
}
