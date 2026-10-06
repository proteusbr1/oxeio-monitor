using System.Runtime.Versioning;
using System.Windows.Forms;

namespace oXeio.Agent.Ui;

/// <summary>
/// The only path for sending work from a background thread to the UI thread.
///
/// <b>Why <c>SynchronizationContext.Current</c> is not used:</b> it is null until some
/// WinForms Control has been created, and it can differ before and after
/// <c>Application.Run</c> starts. The tray is created at the very start of the process, so
/// "assume whatever is there" would silently run work on the wrong thread half the time, and
/// touching NotifyIcon from the wrong thread does not punish you at once; it bites a couple
/// of weeks later.
///
/// Instead we create our own <see cref="Control"/> and create its handle <b>immediately</b>.
/// WinForms parks the handle of a parentless Control in its parking window, and
/// <c>BeginInvoke</c> work runs on the thread that created the handle. So "UI thread" here
/// means exactly the thread this object was created on.
///
/// Careful: <see cref="UiDispatcher"/> (and <see cref="TrayIcon"/>) must be created on the
/// thread that will later call <c>Application.Run()</c>.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class UiDispatcher : IDisposable
{
    private readonly Control _marshaller;
    private readonly Action<Exception>? _onError;
    private volatile bool _disposed;

    public UiDispatcher(Action<Exception>? onError = null)
    {
        _onError = onError;
        _marshaller = new Control();

        // Create the handle up front. Otherwise the first BeginInvoke would throw
        // InvalidOperationException ("Invoke or BeginInvoke cannot be called on a control
        // until the window handle has been created"), on the first status update, i.e. on
        // the tracking thread.
        _ = _marshaller.Handle;
    }

    /// <summary>Needed to size the menu and fonts.</summary>
    public int Dpi
    {
        get
        {
            try { return _marshaller.DeviceDpi; }
            catch (ObjectDisposedException) { return 96; }
        }
    }

    /// <summary>
    /// Runs the action on the UI thread: directly if already on it, otherwise queued.
    ///
    /// Careful: never blocks. There is deliberately no <c>Invoke</c> (synchronous). If the UI
    /// thread were stuck in a modal dialog while the tracking thread waited for it, hour
    /// counting would stop, i.e. the tray would halt payroll.
    /// Careful: never throws either (a requirement of <see cref="oXeio.Core.Agent.IAgentStatusSink"/>).
    /// </summary>
    public void Post(Action action)
    {
        if (action is null || _disposed) return;

        try
        {
            if (!_marshaller.IsHandleCreated) return;

            if (!_marshaller.InvokeRequired)
            {
                Run(action);
                return;
            }

            _marshaller.BeginInvoke(new Action(() => Run(action)));
        }
        catch (ObjectDisposedException)
        {
            // Shutting down; nothing left to draw
        }
        catch (InvalidOperationException)
        {
            // Handle already destroyed
        }
    }

    private void Run(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            // An exception escaping on the UI thread kills the whole process, and tracking
            // with it. So it is swallowed here, but not silently: it goes to the caller's
            // logger if one was given.
            try { _onError?.Invoke(ex); } catch { /* if the logger also fails, nothing more can be done */ }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try { _marshaller.Dispose(); }
        catch (ObjectDisposedException) { }
    }
}
