using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform;

/// <summary>
/// The agent's only window: invisible, but all the news comes through it.
///
/// Careful: <b>not a message-only (HWND_MESSAGE) window, deliberately.</b> Broadcast messages reach
/// only top-level windows. A message-only window would make the code look cleaner and the
/// registration would succeed, but power notifications would never arrive, and with "nothing
/// happening" it could not even be noticed. So WS_POPUP + WS_EX_TOOLWINDOW: top-level, but not on
/// the taskbar or in Alt+Tab.
///
/// <c>Microsoft.Win32.SystemEvents</c> was not used: it hard-codes NOTIFY_FOR_THIS_SESSION, drops
/// lParam, and does not catch PBT_APMRESUMEAUTOMATIC (0x12), which is Windows' only reliable resume
/// signal.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class MessageWindow : NativeWindow, IDisposable
{
    private readonly Action<Message> _onMessage;

    public MessageWindow(Action<Message> onMessage)
    {
        _onMessage = onMessage;

        CreateHandle(new CreateParams
        {
            Caption = "oXeio.Agent.Sink",
            Style = Win32.WS_POPUP,
            ExStyle = Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE,
            X = 0,
            Y = 0,
            Width = 0,
            Height = 0,
            Parent = 0,
        });

        if (Handle == 0)
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "Could not create the window");
    }

    protected override void WndProc(ref Message m)
    {
        // The handler must not be slow: the suspend budget is only about 2 seconds, and that is for
        // all processes combined, not per process.
        try
        {
            _onMessage(m);
        }
        catch
        {
            // the message pump must never be allowed to break
        }

        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (Handle != 0) DestroyHandle();
    }
}
