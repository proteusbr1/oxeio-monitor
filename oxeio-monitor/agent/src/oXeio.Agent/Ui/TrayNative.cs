using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Ui;

/// <summary>
/// The tray's own P/Invoke.
///
/// It lives here rather than in <c>Native/User32.cs</c> because that file belongs to the
/// tracking and capture modules; there is no need to touch another module's file for one
/// function. The name is kept different so that two <c>partial class User32</c> declarations
/// do not clash over the same member.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class TrayNative
{
    /// <summary>
    /// The HICON returned by <see cref="System.Drawing.Bitmap.GetHicon"/> is <b>our</b>
    /// property; GDI does not release it by itself.
    ///
    /// Careful: <c>Icon.FromHandle</c> does not take ownership of the handle, and its
    /// <c>Dispose()</c> does not destroy the handle either. So every HICON created needs
    /// exactly one call to this, otherwise one GDI handle would leak per icon; on a machine
    /// running for weeks, once the 10,000 limit is reached the process can no longer draw
    /// any window.
    /// </summary>
    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool DestroyIcon(nint hIcon);

    /// <summary>
    /// Darkens the title bar (<c>DWMWA_USE_IMMERSIVE_DARK_MODE</c>).
    ///
    /// Careful: we draw the window body ourselves, but <b>Windows draws the title bar</b>.
    /// A white strip on top of a black window drawn in Midnight looks broken rather than
    /// designed, and staff would think something is wrong with the agent.
    /// </summary>
    [LibraryImport("dwmapi.dll")]
    internal static partial int DwmSetWindowAttribute(
        nint hwnd, int attribute, ref int value, int size);

    /// <summary>This is the number on Windows 10 2004+ and 11.</summary>
    private const int UseImmersiveDarkMode = 20;

    /// <summary>
    /// Careful: on 1809-1903 the attribute number was <b>19</b>, later changed to 20. There is
    /// no cheap way to check which build recognizes which, so both are tried; for an unknown
    /// number DWM just returns an HRESULT and nothing breaks.
    /// Our minimum target is 1809, so both are needed.
    /// </summary>
    private const int UseImmersiveDarkModeLegacy = 19;

    /// <summary>Silent on failure: the title bar stays light, the window still works.</summary>
    internal static void TryUseDarkTitleBar(nint hwnd)
    {
        if (hwnd == 0) return;

        var on = 1;

        try
        {
            if (DwmSetWindowAttribute(hwnd, UseImmersiveDarkMode, ref on, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(hwnd, UseImmersiveDarkModeLegacy, ref on, sizeof(int));
            }
        }
        catch (DllNotFoundException)
        {
            // dwmapi.dll is missing; possible on Server Core
        }
        catch (EntryPointNotFoundException)
        {
        }
    }
}
