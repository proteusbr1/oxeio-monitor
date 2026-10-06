using System.Drawing;
using System.Runtime.Versioning;

namespace oXeio.Agent.Ui;

/// <summary>
/// <b>The face of the agent</b>: the red tile with the white X from the web app
/// (<c>web/public/favicon.svg</c>), embedded in the exe.
///
/// Careful: <b>the window icon and the exe icon are not the same thing.</b> The csproj's
/// <c>ApplicationIcon</c> decides Explorer, alt-tab and "Add or remove programs", but
/// <b>the taskbar button</b> shows WinForms's <c>Form.Icon</c>, and if it is not set
/// WinForms uses its own default. So it has to be set separately here.
///
/// Careful: <b>one place only</b>, because there are two kinds of window:
/// <see cref="OwnerDrawnForm"/> (Today · About) and <see cref="SignInForm"/>, and the second
/// does not inherit from the first. At first it was put only on the base class and
/// considered done, but the window staff see <b>first</b> after install was left out.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class BrandIcon
{
    /// <summary>Careful: must match the csproj's <c>LogicalName</c> exactly.</summary>
    private const string ResourceName = "oXeio.Agent.brand.ico";

    /**
     * Read once, shared by all windows.
     *
     * Careful: <c>null</c> on failure, not an exception. The worst result of not finding the
     * icon is the old look on the taskbar, but throwing would mean
     * <b>the sign-in window would not open at all</b>, and the employee could not start work.
     */
    public static Icon? Value => Lazy.Value;

    private static readonly Lazy<Icon?> Lazy = new(() =>
    {
        try
        {
            using var stream = typeof(BrandIcon).Assembly
                .GetManifestResourceStream(ResourceName);

            return stream is null ? null : new Icon(stream);
        }
        catch (Exception)
        {
            return null;
        }
    });
}
