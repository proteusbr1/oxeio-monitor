using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

[StructLayout(LayoutKind.Sequential)]
internal struct POINT
{
    internal int X;
    internal int Y;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_RATIONAL
{
    internal uint Numerator;
    internal uint Denominator;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_MODE_DESC
{
    internal uint Width;
    internal uint Height;
    internal DXGI_RATIONAL RefreshRate;
    internal uint Format;
    internal uint ScanlineOrdering;
    internal uint Scaling;
}

/// <summary>
/// Careful: <c>DeviceName</c> is a <c>fixed char</c>, not <c>ByValTStr</c>, otherwise the struct
/// would become non-blittable (the same as <see cref="MONITORINFOEXW"/>).
///
/// The <c>Monitor</c> field is what really matters: it is the HMONITOR that has to be matched
/// against the monitor coming from <see cref="Platform.Capture.MonitorEnumerator"/>.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DXGI_OUTPUT_DESC
{
    internal fixed char DeviceName[32];
    internal RECT DesktopCoordinates;
    internal int AttachedToDesktop;
    internal uint Rotation;
    internal nint Monitor;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_OUTDUPL_DESC
{
    internal DXGI_MODE_DESC ModeDesc;

    /// <summary>DXGI_MODE_ROTATION: on a rotated display something other than 1 comes in.</summary>
    internal uint Rotation;

    internal int DesktopImageInSystemMemory;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_OUTDUPL_POINTER_POSITION
{
    internal POINT Position;
    internal int Visible;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_OUTDUPL_FRAME_INFO
{
    internal long LastPresentTime;
    internal long LastMouseUpdateTime;

    /// <summary>
    /// Zero means only the cursor moved and the desktop image did not change, yet
    /// <c>AcquireNextFrame</c> still succeeds
    /// ([ADR-012c](../../../../docs/05-Options-Decisions.md)).
    /// </summary>
    internal uint AccumulatedFrames;

    internal int RectsCoalesced;

    /// <summary>
    /// Whether DRM-protected content was excluded: <b>the OS itself reports it</b>. With GDI there
    /// was no way to get this information; black pixels had to be counted as a guess.
    /// </summary>
    internal int ProtectedContentMaskedOut;

    internal DXGI_OUTDUPL_POINTER_POSITION PointerPosition;
    internal uint TotalMetadataBufferSize;
    internal uint PointerShapeBufferSize;
}

/// <summary>
/// DXGI Desktop Duplication: the primary capture engine
/// ([ADR-012c](../../../../docs/05-Options-Decisions.md)).
///
/// All IIDs and slots were counted and matched against
/// <c>Windows Kits\10\Include\10.0.26100.0\shared\{dxgi,dxgi1_2}.h</c>.
///
/// Careful: <b>DXGI's inheritance is in the opposite order to D3D11's.</b> All DXGI interfaces
/// derive from <c>IDXGIObject</c>, whose four methods are in the order SetPrivateData,
/// SetPrivateDataInterface, <b>Get</b>PrivateData, GetParent. In D3D11 the Get comes first and the
/// Set after. Mixing the two up shifts a slot by one and the mistake stays silent.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class Dxgi
{
    // ── IID ─────────────────────────────────────────────────────────────────

    /// <summary>dxgi.h:3119</summary>
    internal static readonly Guid IID_IDXGIFactory1 =
        new("770aae78-f26f-4dba-a829-253c83d1b387");

    /// <summary>dxgi1_2.h:2621</summary>
    internal static readonly Guid IID_IDXGIOutput1 =
        new("00cddea8-939b-4b83-a340-a685226666cc");

    /// <summary>dxgi1_2.h:2614</summary>
    internal static readonly Guid IID_IDXGIOutputDuplication =
        new("191cfac3-a341-470d-b26e-a864f428319c");

    // ── vtable slots ──────────────────────────────────────────────────────
    //
    // IDXGIObject: 3 SetPrivateData, 4 SetPrivateDataInterface,
    //              5 GetPrivateData, 6 GetParent
    // So every DXGI interface's own methods start from 7.

    /// <summary>IDXGIFactory1, dxgi.h: past IDXGIFactory's 5 methods (7-11).</summary>
    internal const int Factory1_EnumAdapters1 = 12;

    /// <summary>IDXGIDevice — dxgi.h</summary>
    internal const int Device_GetAdapter = 7;

    /// <summary>IDXGIAdapter — dxgi.h</summary>
    internal const int Adapter_EnumOutputs = 7;

    /// <summary>IDXGIOutput — dxgi.h</summary>
    internal const int Output_GetDesc = 7;

    /// <summary>
    /// IDXGIOutput1, dxgi1_2.h: past IDXGIOutput's 12 methods (7-18), then GetDisplayModeList1(19),
    /// FindClosestMatchingMode1(20), GetDisplaySurfaceData1(21), then this one.
    /// </summary>
    internal const int Output1_DuplicateOutput = 22;

    /// <summary>IDXGIOutputDuplication. Careful: returns <c>void</c>.</summary>
    internal const int Duplication_GetDesc = 7;

    /// <summary>IDXGIOutputDuplication</summary>
    internal const int Duplication_AcquireNextFrame = 8;

    /// <summary>IDXGIOutputDuplication</summary>
    internal const int Duplication_ReleaseFrame = 14;

    // ── Error codes (winerror.h) ─────────────────────────────────────────

    /// <summary>The desktop did not change at all: <b>not a failure</b>, a normal result.</summary>
    internal const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);

    /// <summary>Mode change / desktop switch / DWM restart: must start over.</summary>
    internal const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);

    /// <summary>
    /// At most 4 duplications can run at once. When Teams or Zoom shares the screen, hitting this
    /// limit really does happen.
    /// </summary>
    internal const int DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = unchecked((int)0x887A0022);

    /// <summary>RDP session: desktop duplication does not work there.</summary>
    internal const int DXGI_ERROR_SESSION_DISCONNECTED = unchecked((int)0x887A0028);

    /// <summary>The driver/adapter cannot do this: no point trying again on this machine.</summary>
    internal const int DXGI_ERROR_UNSUPPORTED = unchecked((int)0x887A0004);

    internal const int DXGI_ERROR_NOT_FOUND = unchecked((int)0x887A0002);
    internal const int DXGI_ERROR_INVALID_CALL = unchecked((int)0x887A0001);

    /// <summary>When the UAC secure desktop or the lock screen is in front.</summary>
    internal const int E_ACCESSDENIED = unchecked((int)0x80070005);

    /// <summary>
    /// These errors are <b>permanent</b> on this machine: retrying every 5 minutes is pointless. On
    /// getting them, we fall all the way back to GDI.
    /// </summary>
    internal static bool IsPermanent(int hr) =>
        hr == DXGI_ERROR_UNSUPPORTED || hr == DXGI_ERROR_NOT_FOUND;

    // ── Entry points ─────────────────────────────────────────────────────

    /// <summary>
    /// dxgi.h: for enumerating adapters.
    ///
    /// Careful: working by creating the device on the default adapter does not work. On a hybrid
    /// graphics laptop (Intel + NVIDIA) the device must be created on <b>exactly the adapter</b>
    /// the monitor is attached to, otherwise <c>DuplicateOutput</c> returns E_INVALIDARG straight
    /// away. Even one laptop in the office will expose this.
    /// </summary>
    [LibraryImport("dxgi.dll")]
    internal static unsafe partial int CreateDXGIFactory1(Guid* riid, nint* factory);
}
