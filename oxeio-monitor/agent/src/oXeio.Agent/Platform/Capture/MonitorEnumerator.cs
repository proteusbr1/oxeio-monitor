using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform.Capture;

internal readonly record struct MonitorInfo(
    nint Handle,
    string DeviceName,
    RECT Bounds,
    bool IsPrimary,
    uint Dpi)
{
    public int Width => Bounds.Width;
    public int Height => Bounds.Height;

    /// <summary>100% = 96 DPI. At 150% it is 144.</summary>
    public double Scale => Dpi / 96.0;
}

/// <summary>
/// Which monitors are currently attached.
///
/// Careful: <b>counted afresh every time, never cached.</b> If a laptop is docked/undocked or a
/// monitor is plugged/unplugged, capturing from an old list would give black images of a monitor
/// that does not exist, and a new monitor would be missed entirely, for as long as the process
/// runs. Counting takes microseconds, so there is no reason to cache.
/// </summary>
[SupportedOSPlatform("windows")]
internal static unsafe class MonitorEnumerator
{
    private const uint MONITORINFOF_PRIMARY = 0x1;

    public static List<MonitorInfo> Enumerate()
    {
        var list = new List<MonitorInfo>(4);
        var handle = GCHandle.Alloc(list);

        try
        {
            User32.EnumDisplayMonitors(0, 0, &Callback, GCHandle.ToIntPtr(handle));
        }
        finally
        {
            handle.Free();
        }

        // sorted left to right, so monitor_index stays the same from run to run
        list.Sort((a, b) => a.Bounds.Left != b.Bounds.Left
            ? a.Bounds.Left.CompareTo(b.Bounds.Left)
            : a.Bounds.Top.CompareTo(b.Bounds.Top));

        return list;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvStdcall)])]
    private static int Callback(nint hMonitor, nint hdc, RECT* rect, nint data)
    {
        try
        {
            if (GCHandle.FromIntPtr(data).Target is not List<MonitorInfo> list) return 1;

            var info = new MONITORINFOEXW { cbSize = (uint)Marshal.SizeOf<MONITORINFOEXW>() };
            if (!User32.GetMonitorInfo(hMonitor, ref info)) return 1;

            uint dpi = 96;
            if (Shcore.GetDpiForMonitor(hMonitor, Shcore.MDT_EFFECTIVE_DPI, out var dx, out _) == 0)
                dpi = dx;

            list.Add(new MonitorInfo(
                hMonitor,
                info.DeviceName,
                info.rcMonitor,
                (info.dwFlags & MONITORINFOF_PRIMARY) != 0,
                dpi));
        }
        catch
        {
            // an exception going from the callback into native code would kill the process
        }

        return 1; // continue
    }
}
