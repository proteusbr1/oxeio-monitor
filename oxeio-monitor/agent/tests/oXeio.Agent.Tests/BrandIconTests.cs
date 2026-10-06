using System.Drawing;
using System.Reflection;
using System.Windows.Forms;

using oXeio.Agent.Ui;
using oXeio.Agent.Security;
using oXeio.Core.Agent;

namespace oXeio.Agent.Tests;

/// <summary>
/// <b>The brand icon: what shows in the taskbar.</b>
///
/// Careful: <b>this file prevents a silent failure.</b> The window icon comes from an
/// embedded resource that is found <b>by name</b> (<c>"oXeio.Agent.brand.ico"</c>). If
/// someone changes the csproj <c>LogicalName</c>, or the file moves, the code gets
/// <c>null</c> and quietly falls back to the old default icon: <b>no error, no log</b>,
/// just the same blank window in the taskbar again.
///
/// This kind of "contract exists, supply does not" mistake has come back in this
/// project again and again, so the name is pinned in a test.
/// </summary>
public class BrandIconTests
{
    /// <summary>Must match the name written in the code exactly (OwnerDrawnForm).</summary>
    private const string ResourceName = "oXeio.Agent.brand.ico";

    private static Assembly AgentAssembly =>
        typeof(oXeio.Agent.Program).Assembly;

    [Fact]
    public void The_icon_is_embedded_under_the_expected_name()
    {
        Assert.Contains(ResourceName, AgentAssembly.GetManifestResourceNames());
    }

    /// <summary>
    /// The resource being present is not enough; it must also be a <b>readable
    /// icon</b>. A broken or empty file would still count as "present".
    /// </summary>
    [Fact]
    public void The_embedded_resource_is_a_real_icon()
    {
        using var stream = AgentAssembly.GetManifestResourceStream(ResourceName);
        Assert.NotNull(stream);

        using var icon = new Icon(stream!);

        Assert.True(icon.Width > 0);
        Assert.True(icon.Height > 0);
    }

    /**
     * <b>The most important test in this file.</b>
     *
     * Careful: an `.ico` holds several sizes, and Windows picks the <b>closest</b> one
     * for each place. Without 16px it would shrink the 32px one, and the stem of the X
     * would look blurry in the taskbar. Each size is drawn separately to avoid exactly
     * that (`installer/make-icon.py`).
     */
    [Theory]
    [InlineData(16)]
    [InlineData(32)]
    [InlineData(48)]
    public void Every_size_WinForms_asks_for_is_present(int side)
    {
        using var stream = AgentAssembly.GetManifestResourceStream(ResourceName);
        using var icon = new Icon(stream!, new Size(side, side));

        // Careful: Icon(stream, size) returns the **closest** size when the requested
        // one is missing, and does not throw. So the size that comes back must be
        // checked, otherwise the test would stay green and prove nothing.
        Assert.Equal(side, icon.Width);
        Assert.Equal(side, icon.Height);
    }

    /**
     * <b>Is 256px present? Read the file's own directory to find out.</b>
     *
     * Careful: this <b>cannot</b> be measured with <c>System.Drawing.Icon</c>, and that
     * is not our file's fault: the ICO format writes 256 as a <c>0</c> byte (256 does
     * not fit in one byte), and that API takes zero literally, so when asked for 256
     * it returns 128. This test was first written with <c>Icon</c> and wrongly
     * complained that the size was missing.
     *
     * Explorer's own loader knows that rule, so the "Extra large icons" view does use
     * the 256 one. So the place to measure is the file, not the API.
     */
    [Fact]
    public void The_file_carries_a_256_entry_for_Explorer()
    {
        using var stream = AgentAssembly.GetManifestResourceStream(ResourceName);
        using var memory = new MemoryStream();
        stream!.CopyTo(memory);
        var bytes = memory.ToArray();

        // ICO header: 2 bytes reserved · 2 bytes type · 2 bytes count
        var count = BitConverter.ToUInt16(bytes, 4);
        Assert.True(count >= 6, $"only {count} sizes in the icon");

        var sides = new List<int>();
        for (var i = 0; i < count; i++)
        {
            // Each entry is 16 bytes, starting 6 bytes in; the first byte is the width
            var w = bytes[6 + (i * 16)];
            sides.Add(w == 0 ? 256 : w);
        }

        Assert.Contains(256, sides);
        Assert.Contains(16, sides);
    }

    /// <summary>
    /// The icon is <b>the brand red</b>, and it shows in the corner: the tile is filled
    /// right to the corner (the favicon.svg rule). If the file is replaced by some other
    /// icon by mistake, this catches it.
    /// </summary>
    [Fact]
    public void It_is_the_red_brand_tile()
    {
        using var stream = AgentAssembly.GetManifestResourceStream(ResourceName);
        using var icon = new Icon(stream!, new Size(32, 32));
        using var bitmap = icon.ToBitmap();

        // Slightly off the middle: the white stem of the X is there
        var tile = bitmap.GetPixel(4, 16);

        Assert.InRange(tile.R, 200, 255);
        Assert.InRange(tile.G, 0, 80);
        Assert.InRange(tile.B, 0, 80);
    }

    // ── do the windows really get the icon? ─────────────────────────────────

    /**
     * <b>The most valuable test in this file, and it comes from a mistake that was caught.</b>
     *
     * At first only <c>Icon = BrandIcon.Value;</c> was set and the job was assumed done.
     * Careful: but with <c>ShowIcon = false</c> WinForms <b>removes</b> the window's
     * icon, even when <c>Icon</c> is set. Measured: with FixedDialog + ShowIcon=false +
     * Icon set, <c>WM_GETICON</c> returns 0 in all three slots.
     *
     * So the line was in the code and looked like "done", yet nothing changed in the
     * taskbar: a perfect silent failure. So the claim is pinned <b>as a pair</b>:
     * icon set <b>and</b> ShowIcon true.
     */
    [Fact]
    public void The_sign_in_window_carries_the_brand_icon()
    {
        OnStaThread(() =>
        {
            using var form = new oXeio.Agent.Ui.SignInForm(
                "https://example.invalid",
                (_, _, _, _) => Task.FromResult(new EnrollmentResult(EnrollmentStatus.ServerUnreachable, "test")));

            AssertShowsAnIcon(form);
        });
    }

    /**
     * Careful: Today and About come from <c>OwnerDrawnForm</c>, but
     * <b>SignInForm does not</b>; it is a separate class. The first attempt set the
     * icon only on the base class and assumed all windows were covered, yet the one
     * staff see <b>first</b> after install was left out.
     *
     * So the two lineages are tested separately.
     */
    [Fact]
    public void The_owner_drawn_windows_carry_the_brand_icon()
    {
        OnStaThread(() =>
        {
            using var fonts = new oXeio.Agent.Ui.TrayFonts();
            using var form = new oXeio.Agent.Ui.AboutForm(fonts, () => new TrayOptions
            {
                AgentVersion = "0.0.0",
                ServerUrl = "https://example.invalid",
            });

            AssertShowsAnIcon(form);
        });
    }

    private static void AssertShowsAnIcon(Form form)
    {
        Assert.NotNull(form.Icon);

        // Careful: `Icon` being set is **not proof**. If ShowIcon is false, Windows
        // sees no icon at all for the window.
        Assert.True(form.ShowIcon, "ShowIcon=false also wipes the Icon that was set");
    }

    /// <summary>
    /// Careful: WinForms controls can only be created on an STA thread, and xunit's
    /// threads are MTA. The thread is created here instead of adding a new package
    /// (Xunit.StaFact); a dependency is not worth it for one icon test.
    /// </summary>
    private static void OnStaThread(Action body)
    {
        Exception? failure = null;

        var thread = new Thread(() =>
        {
            try { body(); }
            catch (Exception ex) { failure = ex; }
        });

        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        // Careful: if a failure inside the thread were not rethrown here, the test
        // would stay **green** and prove nothing.
        if (failure is not null) throw failure;
    }
}
