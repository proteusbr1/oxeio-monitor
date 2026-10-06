using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;

namespace oXeio.Agent.Platform;

internal enum LockState
{
    Unknown,
    Unlocked,
    Locked,
}

/// <summary>
/// Whether the screen is locked right now.
///
/// Events only report <i>changes</i>. If the agent starts while locked (for example auto-login
/// after a reboot, or the watchdog restarted it after a crash), then waiting for an event would
/// make it count time as "unlocked" forever.
///
/// Guessing with <c>OpenInputDesktop</c> was deliberately not done: it also fails on a UAC prompt,
/// the Ctrl+Alt+Del screen or fast user switching, so it would treat states that are not "locked"
/// as locked.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class LockStateProbe
{
    public static LockState Query()
    {
        nint buffer = 0;
        try
        {
            if (!Wtsapi32.WTSQuerySessionInformation(
                    0, Win32.WTS_CURRENT_SESSION, Win32.WTSSessionInfoEx,
                    out buffer, out var bytes)
                || buffer == 0
                || bytes < Marshal.SizeOf<WTSINFOEXW>())
            {
                return LockState.Unknown;
            }

            var info = Marshal.PtrToStructure<WTSINFOEXW>(buffer);

            return info.Data.SessionFlags switch
            {
                Win32.WTS_SESSIONSTATE_LOCK => LockState.Locked,
                Win32.WTS_SESSIONSTATE_UNLOCK => LockState.Unlocked,
                _ => LockState.Unknown,
            };
        }
        finally
        {
            if (buffer != 0) Wtsapi32.WTSFreeMemory(buffer);
        }
    }
}
