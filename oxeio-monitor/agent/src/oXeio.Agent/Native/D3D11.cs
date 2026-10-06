using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace oXeio.Agent.Native;

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_SAMPLE_DESC
{
    internal uint Count;
    internal uint Quality;
}

/// <summary>
/// <c>D3D11_TEXTURE2D_DESC</c> from <c>d3d11.h</c>: the field order must be exactly the same as in
/// the header. If one field is out of place, the driver will read garbage sizes.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_TEXTURE2D_DESC
{
    internal uint Width;
    internal uint Height;
    internal uint MipLevels;
    internal uint ArraySize;
    internal uint Format;
    internal DXGI_SAMPLE_DESC SampleDesc;
    internal uint Usage;
    internal uint BindFlags;
    internal uint CPUAccessFlags;
    internal uint MiscFlags;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct D3D11_MAPPED_SUBRESOURCE
{
    internal void* pData;

    /// <summary>
    /// Careful: bytes per row; <b>almost never <c>Width x 4</c></b>. The driver adds padding as it
    /// sees fit. See <see cref="oXeio.Core.Capture.PixelCopy"/>.
    /// </summary>
    internal uint RowPitch;

    internal uint DepthPitch;
}

/// <summary>
/// The parts of D3D11 needed for desktop duplication: creating the device, the staging texture, and
/// reading from GPU to CPU.
///
/// All constants, IIDs and vtable slots were counted and matched against the headers in
/// <c>C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0</c>. The line each came from is
/// written beside it, so that later someone can verify by opening the header rather than by
/// reasoning.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class D3D11
{
    // ── Constants (d3d11.h, dxgiformat.h, d3dcommon.h) ──────────────────

    /// <summary>d3d11.h:15014 — <c>#define D3D11_SDK_VERSION (7)</c></summary>
    internal const uint SdkVersion = 7;

    /// <summary>
    /// d3dcommon.h:85.
    /// Careful: <b>when the device is created with an adapter passed in, the driver type must be
    /// UNKNOWN</b>: passing HARDWARE makes <c>D3D11CreateDevice</c> return E_INVALIDARG. It is in
    /// the documentation, but the mistake is so common that it is written here too.
    /// </summary>
    internal const uint DriverTypeUnknown = 0;

    /// <summary>
    /// d3d11.h:15007. Duplication surfaces come in BGRA, and Microsoft's own sample creates the
    /// device with this flag too. It costs nothing, so it is kept.
    /// </summary>
    internal const uint CreateDeviceBgraSupport = 0x20;

    /// <summary>
    /// Careful: <c>SINGLETHREADED</c> is deliberately not passed. If capture of several monitors is
    /// made parallel in the future, that flag would silently bring undefined behaviour.
    /// </summary>
    internal const uint CreateDeviceFlags = CreateDeviceBgraSupport;

    /// <summary>dxgiformat.h:100: what desktop duplication gives on a normal display.</summary>
    internal const uint FormatB8G8R8A8Unorm = 87;

    /// <summary>d3d11.h:1222: the only usage for reading from GPU to CPU.</summary>
    internal const uint UsageStaging = 3;

    /// <summary>d3d11.h:1244. Careful: not 0x1, which is a different flag.</summary>
    internal const uint CpuAccessRead = 0x20000;

    /// <summary>d3d11.h:1275</summary>
    internal const uint MapRead = 1;

    // ── IID (from the header's DEFINE_GUID) ─────────────────────────────

    /// <summary>d3d11.h:15171</summary>
    internal static readonly Guid IID_ID3D11Texture2D =
        new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    // ── vtable slots ──────────────────────────────────────────────────────
    //
    // Careful: these numbers are the most fragile part of this file. Each was counted from the
    // header's CINTERFACE vtable struct, including the 3 IUnknown slots. Count again before
    // changing; a mistake is silent.

    /// <summary>
    /// ID3D11Device: QI/AddRef/Release, CreateBuffer, CreateTexture1D, then this. Careful:
    /// ID3D11Device derives directly from IUnknown, not from <c>ID3D11DeviceChild</c>. Assuming
    /// DeviceChild would shift by 4 slots and call <c>CreateTexture1D</c> instead.
    /// </summary>
    internal const int Device_CreateTexture2D = 5;

    /// <summary>ID3D11DeviceContext. Careful: this derives from ID3D11DeviceChild (7
    /// slots).</summary>
    internal const int Context_Map = 14;

    /// <summary>ID3D11DeviceContext. Careful: returns <c>void</c>.</summary>
    internal const int Context_Unmap = 15;

    /// <summary>ID3D11DeviceContext. Careful: returns <c>void</c>; there is no way to know if it
    /// failed.</summary>
    internal const int Context_CopyResource = 47;

    /// <summary>
    /// ID3D11Texture2D: inheritance IUnknown(3) then DeviceChild(+4) then Resource(+3). Careful:
    /// returns <c>void</c>.
    /// </summary>
    internal const int Texture2D_GetDesc = 10;

    // ── Entry points ─────────────────────────────────────────────────────

    /// <summary>d3d11.h:15075. <c>pFeatureLevels</c> and <c>ppImmediateContext</c> may be
    /// null.</summary>
    [LibraryImport("d3d11.dll")]
    internal static unsafe partial int D3D11CreateDevice(
        nint pAdapter,
        uint driverType,
        nint software,
        uint flags,
        uint* pFeatureLevels,
        uint featureLevels,
        uint sdkVersion,
        nint* ppDevice,
        uint* pFeatureLevel,
        nint* ppImmediateContext);
}
