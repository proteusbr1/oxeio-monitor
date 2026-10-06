using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform;

/// <summary>
/// News of sleep and wake.
///
/// <b>This is only a way to find out quickly, not the source of truth.</b> Detecting sleep is
/// really the job of <see cref="oXeio.Core.Tracking.SleepGapDetector"/>, because when a PC sleeps
/// from a flat battery or for thermal reasons, Windows sends no notification at all. Registration
/// here is only for finding out quickly.
///
/// <c>RegisterSuspendResumeNotification</c> is not a workaround for modern standby, it is the rule:
/// in S0ix Windows no longer sends the broadcast unasked, and sends it once registered.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class PowerMonitor : IDisposable
{
    private readonly nint _hwnd;
    private nint _suspendResume;
    private nint _displayStatus;

    /// <summary>Resume can arrive twice (0x12 and 0x07): within this time only one is
    /// counted.</summary>
    private static readonly TimeSpan ResumeDedupe = TimeSpan.FromSeconds(5);
    private DateTimeOffset _lastResume = DateTimeOffset.MinValue;

    public PowerMonitor(nint hwnd) => _hwnd = hwnd;

    public (bool Ok, int Error) TryRegister()
    {
        _suspendResume = User32.RegisterSuspendResumeNotification(
            _hwnd, Win32.DEVICE_NOTIFY_WINDOW_HANDLE);

        if (_suspendResume == 0)
            return (false, Marshal.GetLastPInvokeError());

        // display turning off = the earliest signal of entering modern standby
        _displayStatus = User32.RegisterPowerSettingNotification(
            _hwnd, in Win32.GUID_SESSION_DISPLAY_STATUS, Win32.DEVICE_NOTIFY_WINDOW_HANDLE);

        return (true, 0);
    }

    /// <summary>
    /// Works out the meaning of <c>WM_POWERBROADCAST</c>. If resume arrives twice, it returns it
    /// only once.
    /// </summary>
    public PowerSignal? Interpret(nint wParam, nint lParam, DateTimeOffset now)
    {
        switch ((int)wParam)
        {
            case Win32.PBT_APMSUSPEND:
                return PowerSignal.Suspend;

            case Win32.PBT_APMRESUMEAUTOMATIC:
            case Win32.PBT_APMRESUMESUSPEND:
                if (now - _lastResume < ResumeDedupe) return null;
                _lastResume = now;
                return PowerSignal.Resume;

            case Win32.PBT_POWERSETTINGCHANGE:
                return ReadDisplayState(lParam) switch
                {
                    Win32.MONITOR_DISPLAY_OFF => PowerSignal.DisplayOff,
                    Win32.MONITOR_DISPLAY_ON => PowerSignal.DisplayOn,
                    _ => null,
                };

            default:
                return null;
        }
    }

    private static int ReadDisplayState(nint lParam)
    {
        if (lParam == 0) return -1;

        var setting = Marshal.PtrToStructure<POWERBROADCAST_SETTING>(lParam);
        if (setting.PowerSetting != Win32.GUID_SESSION_DISPLAY_STATUS || setting.DataLength < 4)
            return -1;

        // Data is a 4-byte DWORD, at the end of the structure
        var dataOffset = Marshal.OffsetOf<POWERBROADCAST_SETTING>(nameof(POWERBROADCAST_SETTING.Data));
        return Marshal.ReadInt32(lParam + dataOffset.ToInt32());
    }

    public void Dispose()
    {
        if (_displayStatus != 0)
        {
            User32.UnregisterPowerSettingNotification(_displayStatus);
            _displayStatus = 0;
        }

        if (_suspendResume != 0)
        {
            User32.UnregisterSuspendResumeNotification(_suspendResume);
            _suspendResume = 0;
        }
    }
}

internal enum PowerSignal
{
    Suspend,
    Resume,
    DisplayOff,
    DisplayOn,
}
