using System.Runtime.InteropServices;

namespace oXeio.Agent.Native;

/// <summary>
/// Careful: <c>cbSize</c> really is validated: a wrong value makes the call fail (error 87) and
/// <c>dwTime</c> stays zero. Using it without checking the return value would compute inactivity as
/// "since the PC was switched on until now". 8 bytes: uint + uint.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal struct LASTINPUTINFO
{
    internal uint cbSize;
    internal uint dwTime;
}

[StructLayout(LayoutKind.Sequential)]
internal struct POWERBROADCAST_SETTING
{
    internal Guid PowerSetting;
    internal uint DataLength;
    /// <summary>The first byte; the rest follows it. A 4-byte DWORD for the display
    /// status.</summary>
    internal byte Data;
}

/// <summary>
/// Careful: because of <c>ByValTStr</c> this is not blittable, so it cannot be given to
/// source-generated marshalling; it must be read with <c>Marshal.PtrToStructure</c>. Careful:
/// <c>Pack = 1</c> must not be used; the default alignment is what matches the native layout.
/// </summary>
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct WTSINFOEX_LEVEL1_W
{
    internal uint SessionId;
    internal int SessionState;

    /// <summary>0 = LOCK · 1 = UNLOCK · -1 = UNKNOWN</summary>
    internal int SessionFlags;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] internal string WinStationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] internal string UserName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] internal string DomainName;

    internal long LogonTime;
    internal long ConnectTime;
    internal long DisconnectTime;
    internal long LastInputTime;
    internal long CurrentTime;

    internal uint IncomingBytes;
    internal uint OutgoingBytes;
    internal uint IncomingFrames;
    internal uint OutgoingFrames;
    internal uint IncomingCompressedBytes;
    internal uint OutgoingCompressedBytes;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct WTSINFOEXW
{
    internal uint Level;
    internal WTSINFOEX_LEVEL1_W Data;
}
