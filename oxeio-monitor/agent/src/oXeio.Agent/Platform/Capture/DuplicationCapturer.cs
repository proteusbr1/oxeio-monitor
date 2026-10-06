using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Capture;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// DXGI Desktop Duplication: the primary capture engine
/// ([ADR-012c](../../../../docs/05-Options-Decisions.md)).
///
/// <b>What it gives over GDI:</b> hardware-accelerated video and exclusive-fullscreen windows come
/// out as the real image, not black. Also the OS itself says whether DRM content was excluded
/// (<c>ProtectedContentMaskedOut</c>); with GDI there was no way except guessing.
///
/// <b>What it does not give:</b> DRM-protected windows will still come out black here. That is the
/// OS's content protection, not a limit of the capture API, and we will not try to get around it.
///
/// <b>The whole chain is built afresh and torn down every time.</b> Taking an image once in 5
/// minutes this is practically free, and it handles resolution changes, dock/undock, monitor
/// plug/unplug, GPU resets and user switches automatically. Keeping the chain would require
/// handling <c>ACCESS_LOST</c> separately for each of these, and one mistake would leave that PC
/// without images for months, with nobody seeing it.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed unsafe class DuplicationCapturer : IScreenCapturer
{
    /// <summary>
    /// How long to wait for a frame each time.
    ///
    /// When video is playing frames arrive about every 16 milliseconds, so 250 ms is more than
    /// enough. And when the screen is still, no frame will come however long we wait, so there is
    /// no gain in delaying; it is better to drop quickly to GDI.
    /// </summary>
    private const uint FrameTimeoutMs = 250;

    private const int Retries = 2;

    public string Name => "DXGI";

    /// <summary>
    /// <b>"No image obtained" and "DXGI does not work on this machine" are not the same thing.</b>
    ///
    /// When the screen is still DXGI cannot give an image, but that is not the engine's fault.
    /// Without this distinction, on a quiet office PC DXGI would go on a pause after several slots
    /// in a row ([EngineFallbackPolicy](../../../oXeio.Core/Capture/EngineFallbackPolicy.cs)), so
    /// on a machine where someone then started watching video, DXGI would be asleep exactly then.
    /// </summary>
    public bool EngineFault { get; private set; }

    bool IScreenCapturer.LastFailureWasEngineFault => EngineFault;

    /// <summary>
    /// Where the last attempt stopped.
    ///
    /// Careful: by contract it returns <c>null</c> on failure, not an exception, which means that
    /// unless the reason is kept somewhere it would be lost for good. The answer to "why does this
    /// PC always fall back to GDI" can be found only here.
    /// </summary>
    public string LastStep { get; private set; } = "not attempted yet";

    public CapturedFrame? Capture(MonitorInfo monitor)
    {
        nint factory = 0, adapter = 0, output = 0, output1 = 0;
        nint device = 0, context = 0, duplication = 0;
        nint desktop = 0, texture = 0, staging = 0;
        var mapped = false;

        // Careful: the fault is assumed to be the engine's. The steps that are really not at fault
        // set this to false themselves. Doing it the other way round, any new failure path added
        // later would silently count as "not at fault", and the fallback policy would never kick
        // in.
        EngineFault = true;

        try
        {
            LastStep = "looking for an output";
            if (!TryFindOutput(monitor.Handle, ref factory, ref adapter, ref output))
                return null;

            LastStep = "D3D11 device";
            if (!TryCreateDevice(adapter, ref device, ref context))
                return null;

            LastStep = "IDXGIOutput1";
            if (ComCall.QueryInterface(output, Dxgi.IID_IDXGIOutput1, out output1) < 0)
                return null;

            LastStep = "DuplicateOutput";
            var hr = ((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)
                ComCall.Method(output1, Dxgi.Output1_DuplicateOutput))(output1, device, &duplication);

            // Careful: E_ACCESSDENIED means the secure desktop (UAC/lock screen) is in front, and
            // NOT_CURRENTLY_AVAILABLE means the limit of 4 simultaneous duplications was hit, which
            // does happen when Teams/Zoom is sharing. Both are temporary; this slot will be
            // captured via GDI.
            if (hr < 0) return null;

            LastStep = "checking rotation";
            var turns = PixelCopy.TurnsForRotation(RotationOf(duplication));

            LastStep = "waiting for a frame";
            if (!TryAcquire(duplication, out var info, ref desktop)) return null;

            LastStep = $"got a frame (accumulated={info.AccumulatedFrames}, " +
                       $"present={info.LastPresentTime}, drm={info.ProtectedContentMaskedOut})";

            if (ComCall.QueryInterface(desktop, D3D11.IID_ID3D11Texture2D, out texture) < 0)
                return null;

            D3D11_TEXTURE2D_DESC desc;
            ((delegate* unmanaged[Stdcall]<nint, D3D11_TEXTURE2D_DESC*, void>)
                ComCall.Method(texture, D3D11.Texture2D_GetDesc))(texture, &desc);

            // On an HDR monitor the format may be R16G16B16A16_FLOAT. Forcing the bytes to be read
            // as BGRA would give colourful garbage, which looks just like "an image was taken". So
            // when we do not understand it, the rule is not to touch it.
            if (desc.Format != D3D11.FormatB8G8R8A8Unorm) return null;

            if (!TryCreateStaging(device, desc, ref staging)) return null;

            ((delegate* unmanaged[Stdcall]<nint, nint, nint, void>)
                ComCall.Method(context, D3D11.Context_CopyResource))(context, staging, texture);

            // Careful: release **right after** the copy, before Map. Releasing invalidates the
            // desktop surface; releasing earlier would leave nothing to copy.
            ((delegate* unmanaged[Stdcall]<nint, int>)
                ComCall.Method(duplication, Dxgi.Duplication_ReleaseFrame))(duplication);

            D3D11_MAPPED_SUBRESOURCE map;
            hr = ((delegate* unmanaged[Stdcall]<nint, nint, uint, uint, uint, D3D11_MAPPED_SUBRESOURCE*, int>)
                ComCall.Method(context, D3D11.Context_Map))(context, staging, 0, D3D11.MapRead, 0, &map);
            if (hr < 0) return null;

            mapped = true;

            // Careful: on a rotated display the monitor's size (1080x1920) and the surface's size
            // (1920x1080) are swapped. So if clamping **before** rotating, the monitor's size must
            // be swapped too, otherwise half the image would be cut off.
            var swapped = turns is 1 or 3;
            var wantW = swapped ? monitor.Height : monitor.Width;
            var wantH = swapped ? monitor.Width : monitor.Height;

            var (w, h) = PixelCopy.ContentBounds((int)desc.Width, (int)desc.Height, wantW, wantH);
            if (w <= 0 || h <= 0) return null;

            LastStep += $" · {desc.Width}×{desc.Height} pitch={map.RowPitch} → {w}×{h}" +
                        (turns == 0 ? "" : $" · rotation {turns * 90}°");

            var source = new ReadOnlySpan<byte>(map.pData, checked((int)(map.RowPitch * desc.Height)));
            var tight = PixelCopy.ToTightBuffer(source, (int)map.RowPitch, w, h);

            var (pixels, finalW, finalH) = PixelCopy.RotateClockwise(tight, w, h, turns);

            EngineFault = false;

            return new CapturedFrame(
                pixels, finalW, finalH, finalW * PixelCopy.BytesPerPixel, monitor, Name)
            {
                ProtectedContentMasked = info.ProtectedContentMaskedOut != 0,
            };
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // By contract, if one monitor fails the result is null, not an exception, so the other
            // monitors' images are still taken.
            return null;
        }
        finally
        {
            // Careful: if Unmap is skipped, the staging texture stays mapped forever and every Map
            // fails for the rest of this process's life. The mistake shows up weeks later, as some
            // other symptom.
            if (mapped && context != 0 && staging != 0)
            {
                ((delegate* unmanaged[Stdcall]<nint, nint, uint, void>)
                    ComCall.Method(context, D3D11.Context_Unmap))(context, staging, 0);
            }

            ComCall.Release(ref staging);
            ComCall.Release(ref texture);
            ComCall.Release(ref desktop);
            ComCall.Release(ref duplication);
            ComCall.Release(ref output1);
            ComCall.Release(ref context);
            ComCall.Release(ref device);
            ComCall.Release(ref output);
            ComCall.Release(ref adapter);
            ComCall.Release(ref factory);
        }
    }

    // ── Steps ────────────────────────────────────────────────────────────

    /// <summary>
    /// Which adapter and which output this HMONITOR belongs to: searched across all adapters.
    ///
    /// Careful: the default (number 0) adapter cannot be assumed. On a hybrid-graphics laptop the
    /// built-in screen is on one adapter and the external monitor on another.
    /// </summary>
    private static bool TryFindOutput(nint hMonitor, ref nint factory, ref nint adapter, ref nint output)
    {
        nint f = 0;
        fixed (Guid* iid = &Dxgi.IID_IDXGIFactory1)
        {
            if (Dxgi.CreateDXGIFactory1(iid, &f) < 0) return false;
        }

        factory = f;

        for (uint ai = 0; ; ai++)
        {
            nint a = 0;
            if (((delegate* unmanaged[Stdcall]<nint, uint, nint*, int>)
                    ComCall.Method(factory, Dxgi.Factory1_EnumAdapters1))(factory, ai, &a) < 0)
            {
                return false; // DXGI_ERROR_NOT_FOUND: no more adapters
            }

            for (uint oi = 0; ; oi++)
            {
                nint o = 0;
                if (((delegate* unmanaged[Stdcall]<nint, uint, nint*, int>)
                        ComCall.Method(a, Dxgi.Adapter_EnumOutputs))(a, oi, &o) < 0)
                {
                    break; // no more outputs on this adapter
                }

                DXGI_OUTPUT_DESC desc;
                ((delegate* unmanaged[Stdcall]<nint, DXGI_OUTPUT_DESC*, int>)
                    ComCall.Method(o, Dxgi.Output_GetDesc))(o, &desc);

                if (desc.Monitor == hMonitor && desc.AttachedToDesktop != 0)
                {
                    adapter = a;
                    output = o;
                    return true;
                }

                ComCall.Release(ref o);
            }

            ComCall.Release(ref a);
        }
    }

    private static bool TryCreateDevice(nint adapter, ref nint device, ref nint context)
    {
        nint dev = 0, ctx = 0;
        uint level;

        var hr = D3D11.D3D11CreateDevice(
            adapter,
            D3D11.DriverTypeUnknown, // Careful: UNKNOWN is mandatory when an adapter is passed
            0,
            D3D11.CreateDeviceFlags,
            null, 0,
            D3D11.SdkVersion,
            &dev, &level, &ctx);

        if (hr < 0) return false;

        device = dev;
        context = ctx;
        return true;
    }

    /// <summary>How far the display is rotated: <c>DXGI_MODE_ROTATION</c>.</summary>
    private static uint RotationOf(nint duplication)
    {
        DXGI_OUTDUPL_DESC desc;
        ((delegate* unmanaged[Stdcall]<nint, DXGI_OUTDUPL_DESC*, void>)
            ComCall.Method(duplication, Dxgi.Duplication_GetDesc))(duplication, &desc);

        return desc.Rotation;
    }

    /// <summary>
    /// Careful: <b>a successful <c>AcquireNextFrame</c> does not mean an image was obtained.</b>
    ///
    /// Right after <c>DuplicateOutput</c> the first call almost always succeeds, but with
    /// <c>AccumulatedFrames = 0</c> and <c>LastPresentTime = 0</c>, meaning "the desktop did not
    /// change". No image is put on that frame's surface; it is entirely black.
    ///
    /// This was measured on this very machine: call successful, HRESULT fine, size fine (1920x1080,
    /// pitch 7680), only every pixel zero. Being satisfied with the return value would have
    /// collected perfectly black images for months.
    ///
    /// So empty frames are released and we wait for a real image.
    /// </summary>
    private bool TryAcquire(nint duplication, out DXGI_OUTDUPL_FRAME_INFO info, ref nint desktop)
    {
        info = default;

        for (var attempt = 0; attempt <= Retries; attempt++)
        {
            DXGI_OUTDUPL_FRAME_INFO fi;
            nint res = 0;

            var hr = ((delegate* unmanaged[Stdcall]<nint, uint, DXGI_OUTDUPL_FRAME_INFO*, nint*, int>)
                ComCall.Method(duplication, Dxgi.Duplication_AcquireNextFrame))(
                    duplication, FrameTimeoutMs, &fi, &res);

            if (hr < 0)
            {
                if (hr == Dxgi.DXGI_ERROR_WAIT_TIMEOUT) continue;

                LastStep = $"AcquireNextFrame failed (0x{hr:X8})";
                EngineFault = !IsTransient(hr);
                return false;
            }

            // whether there really is an image: it is enough if either of the two is non-zero
            if (fi.AccumulatedFrames > 0 || fi.LastPresentTime != 0)
            {
                info = fi;
                desktop = res;
                return true;
            }

            // Empty frame: release it and go again. Careful: without releasing, the next
            // AcquireNextFrame fails outright.
            ComCall.Release(ref res);
            ((delegate* unmanaged[Stdcall]<nint, int>)
                ComCall.Method(duplication, Dxgi.Duplication_ReleaseFrame))(duplication);
        }

        // Nothing on screen is moving. That is not the engine's fault, and in exactly this
        // situation GDI gives a perfect image, because the only reason for black is moving video.
        LastStep = "no change on screen — falling back to GDI";
        EngineFault = false;
        return false;
    }

    /// <summary>These errors pass: it does not mean the machine cannot do DXGI.</summary>
    private static bool IsTransient(int hr) =>
        hr == Dxgi.DXGI_ERROR_ACCESS_LOST ||
        hr == Dxgi.DXGI_ERROR_NOT_CURRENTLY_AVAILABLE ||
        hr == Dxgi.E_ACCESSDENIED;

    private static bool TryCreateStaging(nint device, D3D11_TEXTURE2D_DESC source, ref nint staging)
    {
        // Careful: with STAGING, passing anything other than zero for BindFlags means it is not
        // created at all. MipLevels 1, ArraySize 1, no multisampling: otherwise CopyResource
        // silently does nothing because the sizes do not match.
        var desc = new D3D11_TEXTURE2D_DESC
        {
            Width = source.Width,
            Height = source.Height,
            MipLevels = 1,
            ArraySize = 1,
            Format = source.Format,
            SampleDesc = new DXGI_SAMPLE_DESC { Count = 1, Quality = 0 },
            Usage = D3D11.UsageStaging,
            BindFlags = 0,
            CPUAccessFlags = D3D11.CpuAccessRead,
            MiscFlags = 0,
        };

        nint tex = 0;
        var hr = ((delegate* unmanaged[Stdcall]<nint, D3D11_TEXTURE2D_DESC*, nint, nint*, int>)
            ComCall.Method(device, D3D11.Device_CreateTexture2D))(device, &desc, 0, &tex);

        if (hr < 0) return false;

        staging = tex;
        return true;
    }

    public void Dispose() { }
}
