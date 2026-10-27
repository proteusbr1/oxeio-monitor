using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Capture;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// DXGI Desktop Duplication: the primary capture engine
/// ([ADR-012c](../../../../docs/history/05-Options-Decisions.md)).
///
/// <b>What it gives over GDI:</b> hardware-accelerated video and exclusive-fullscreen windows come
/// out as the real image, not black. Also the OS itself says whether DRM content was excluded
/// (<c>ProtectedContentMaskedOut</c>); with GDI there was no way except guessing.
///
/// <b>What it does not give:</b> DRM-protected windows will still come out black here. That is the
/// OS's content protection, not a limit of the capture API, and we will not try to get around it.
///
/// <b>The chain is kept between captures, one per output, and thrown away whole on any
/// doubt.</b> Factory, adapter, output, device, context, duplication and the staging texture stay
/// alive, keyed by HMONITOR, and are reused by the next capture of that monitor.
///
/// <b>Why it is no longer rebuilt every time.</b> It used to be, on the grounds that "one image
/// in 5 minutes makes it practically free". Two things made that false. First, since G46 every
/// monitor is captured for the fingerprint once a minute, and every 5 seconds while the screen is
/// frozen (<see cref="oXeio.Core.Tracking.ScreenSampling"/>): about 9,000 chains a day on a
/// two-monitor PC. Second, NVIDIA App / ShadowPlay injects <c>nvspcap64.dll</c> into every
/// process that creates a DXGI chain, and it leaks one Section, one Mutex and one mapped view per
/// chain creation, about 600 MB of private memory a day, measured on a real office PC. Our own
/// COM references were balanced; the only cure is to stop creating chains.
///
/// <b>Why that does not bring back the risk the old comment feared</b> (one missed
/// <c>ACCESS_LOST</c> case leaving a PC without images for months): there is no per-case
/// recovery. The rule is the old one, shifted by one step: <b>any failure anywhere — an
/// HRESULT, an exception, a mismatch — discards that output's whole set, and the next capture
/// builds it from nothing</b>, exactly as the old code did every time. Before a set is reused it is
/// also checked (<see cref="WhyStale"/>): device removed, factory no longer current, output moved
/// or detached, mode or rotation changed. And when a reused set fails, a fresh one is tried at
/// once in the same call, so a reused set can never cost an image that a fresh one would have
/// given. The only thing that is not a failure is "nothing changed on screen" (a timeout), which
/// on a persistent duplication is the normal answer on a still screen.
///
/// Careful: <b>a kept duplication holds one of the few simultaneous duplication slots of that
/// output</b> (the same ones Teams/Zoom screen sharing uses). That is accepted: one slot is ours
/// either way while capturing, and a set unused for <see cref="IdleEvictAfter"/> is released
/// (which also frees the sets of unplugged monitors).
///
/// Careful: <b>every acquired frame must be released on every path.</b> With a fresh duplication
/// per capture a forgotten <c>ReleaseFrame</c> died with the duplication; on a kept one it makes
/// every later <c>AcquireNextFrame</c> fail with <c>DXGI_ERROR_INVALID_CALL</c>.
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

    /// <summary>
    /// A kept set that has not been used for this long is released.
    ///
    /// Fingerprints come every 60 seconds (<see cref="oXeio.Core.Tracking.ScreenSampling.Interval"/>),
    /// so in normal work a set is never this old. It gets this old only when an unplugged monitor's
    /// HMONITOR stops being asked for, or when sampling is off (locked, display off, outside the
    /// window, DXGI resting after failures). Then holding a duplication slot and a screen-sized
    /// staging texture buys nothing, and the rebuild afterwards is one chain, not thousands.
    ///
    /// Careful: eviction only runs inside <see cref="Capture"/> (the COM objects have one owner;
    /// there is no timer thread touching them). So overnight the sets stay until the morning's
    /// first capture, which then rebuilds them; that is the price of not adding a second thread.
    /// </summary>
    private static readonly TimeSpan IdleEvictAfter = TimeSpan.FromMinutes(10);

    /**
     * Careful: <b>today there is exactly one caller</b>, the capture loop
     * (<c>AgentHost.CaptureLoopAsync</c>; <c>Diagnostics</c> builds its own instance). The lock
     * is still needed, for <see cref="Dispose"/>: the loop is fire-and-forget, so at shutdown
     * <c>DisposeAsync</c> can release the sets while a capture is half-way through using them. The
     * lock costs nothing next to a 250 ms frame wait.
     */
    private readonly object _gate = new();

    /// <summary>The kept sets, one per output, keyed by HMONITOR.</summary>
    private readonly Dictionary<nint, Chain> _chains = [];

    private bool _disposed;

    public CapturedFrame? Capture(MonitorInfo monitor)
    {
        lock (_gate)
        {
            // Careful: the fault is assumed to be the engine's. The steps that are really not at
            // fault set this to false themselves. Doing it the other way round, any new failure
            // path added later would silently count as "not at fault", and the fallback policy
            // would never kick in.
            EngineFault = true;

            if (_disposed)
            {
                // Shutting down: not the engine's fault, GDI may still answer this one.
                LastStep = "disposed";
                EngineFault = false;
                return null;
            }

            var now = Environment.TickCount64;
            var how = EvictIdle(now, monitor.Handle)
                ? $"rebuilt (unused for over {IdleEvictAfter.TotalMinutes:0} min)"
                : "built (none kept for this output)";

            // Careful: whatever is still in this variable when the method leaves is released by
            // the finally. A set goes back into _chains only on a healthy result, so "any failure,
            // even one nobody foresaw, throws the whole set away" holds without each path having
            // to remember it.
            Chain? chain = null;

            try
            {
                if (_chains.Remove(monitor.Handle, out chain))
                {
                    var stale = WhyStale(chain, monitor.Handle);
                    if (stale is null)
                    {
                        var frame = Attempt(chain, monitor, out var healthy);
                        if (healthy)
                        {
                            Keep(chain, now);
                            LastStep += $" · chain reused ({chain.Uses}×)";
                            chain = null;
                            return frame;
                        }

                        how = $"rebuilt (the kept one failed: {LastStep})";
                    }
                    else
                    {
                        how = $"rebuilt ({stale})";
                    }

                    /**
                     * Careful: <b>a kept set must never cost an image that a fresh one would
                     * have given.</b> The old code built a new chain every time, so after a mode
                     * change or a desktop switch its next capture simply worked. Here the kept
                     * set would answer ACCESS_LOST first; so the set goes, and a fresh one is
                     * tried at once, in this same call. A fresh set that fails is not retried
                     * again: that is the old behaviour exactly.
                     */
                    chain.Dispose();
                    chain = null;
                    EngineFault = true;
                }

                chain = new Chain(monitor.Handle);

                if (!TryBuild(chain))
                {
                    LastStep += $" · chain {how}";
                    return null;
                }

                var fresh = Attempt(chain, monitor, out var ok);
                LastStep += $" · chain {how}";

                if (ok)
                {
                    Keep(chain, now);
                    chain = null;
                }

                return fresh;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // By contract, if one monitor fails the result is null, not an exception, so the
                // other monitors' images are still taken. The set goes in the finally.
                LastStep += $" · {ex.GetType().Name}: {ex.Message}";
                return null;
            }
            finally
            {
                chain?.Dispose();
            }
        }
    }

    // ── The kept set ─────────────────────────────────────────────────────

    /// <summary>
    /// Everything DXGI needs to capture one output, kept alive between captures.
    ///
    /// Careful: the fields are plain handles on purpose, so <see cref="ComCall.Release"/> can zero
    /// them; <see cref="Dispose"/> is then safe however far <see cref="TryBuild"/> got, and safe to
    /// call twice.
    /// </summary>
    private sealed class Chain(nint monitor)
    {
        public readonly nint Monitor = monitor;

        public nint Factory, Adapter, Output, Output1, Device, Context, Duplication, Staging;

        /// <summary>Valid only while <see cref="Staging"/> is non-zero.</summary>
        public D3D11_TEXTURE2D_DESC StagingDesc;

        /// <summary>What the output and the duplication looked like when the set was built.</summary>
        public OutputState BuiltOutput;
        public ModeState BuiltMode;

        public long LastUsedAt;
        public int Uses;

        public void Dispose()
        {
            // Children first, the factory last: the reverse of the order they were made in.
            ComCall.Release(ref Staging);
            ComCall.Release(ref Duplication);
            ComCall.Release(ref Output1);
            ComCall.Release(ref Context);
            ComCall.Release(ref Device);
            ComCall.Release(ref Output);
            ComCall.Release(ref Adapter);
            ComCall.Release(ref Factory);
        }
    }

    /// <summary>
    /// The parts of <c>DXGI_OUTPUT_DESC</c> that say "this is still the same screen, in the same
    /// place".
    /// </summary>
    private readonly record struct OutputState(
        nint Monitor, int Left, int Top, int Right, int Bottom, bool Attached, uint Rotation)
    {
        public override string ToString() =>
            $"{Right - Left}×{Bottom - Top} @{Left},{Top} rot={Rotation}" +
            (Attached ? "" : " detached");
    }

    /// <summary>The parts of <c>DXGI_OUTDUPL_DESC</c> the copy depends on.</summary>
    private readonly record struct ModeState(uint Width, uint Height, uint Rotation)
    {
        public override string ToString() => $"{Width}×{Height} rot={Rotation}";
    }

    private void Keep(Chain chain, long now)
    {
        chain.LastUsedAt = now;
        chain.Uses++;
        _chains[chain.Monitor] = chain;
    }

    /// <summary>
    /// Releases the sets unused for <see cref="IdleEvictAfter"/>. Returns whether the one for
    /// <paramref name="current"/> was among them, only so <see cref="LastStep"/> can say why it is
    /// being rebuilt.
    /// </summary>
    private bool EvictIdle(long now, nint current)
    {
        var limit = (long)IdleEvictAfter.TotalMilliseconds;
        List<nint>? idle = null;

        foreach (var (handle, chain) in _chains)
        {
            if (now - chain.LastUsedAt > limit) (idle ??= []).Add(handle);
        }

        if (idle is null) return false;

        foreach (var handle in idle)
        {
            if (_chains.Remove(handle, out var chain)) chain.Dispose();
        }

        return idle.Contains(current);
    }

    /// <summary>
    /// Why a kept set may not be reused, or <c>null</c> if it may.
    ///
    /// All of these are cheap queries (no GPU work, no frame wait), and each covers a case where
    /// the old "fresh every time" chain would have silently done the right thing:
    ///   - device removed: driver update, TDR, an eGPU unplugged
    ///     (<see cref="Dxgi.DXGI_ERROR_DEVICE_REMOVED"/>, <see cref="Dxgi.DXGI_ERROR_DEVICE_RESET"/>)
    ///   - factory not current: adapters or outputs were added/removed since it was made
    ///   - output changed: moved in the desktop layout, detached, rotated, or the HMONITOR now
    ///     belongs to something else
    ///   - mode changed: resolution or rotation of the duplicated surface
    ///
    /// Careful: most of these also surface as <c>ACCESS_LOST</c> on the next acquire, and that path
    /// rebuilds too. Checking here first only spares a wasted frame wait and gives
    /// <see cref="LastStep"/> a precise reason; it is a belt, not the only brace. In particular the
    /// duplication's own desc may well never change on a live duplication (a mode change normally
    /// shows up as ACCESS_LOST), but reading it costs nothing.
    /// </summary>
    private static string? WhyStale(Chain chain, nint hMonitor)
    {
        var removed = ((delegate* unmanaged[Stdcall]<nint, int>)
            ComCall.Method(chain.Device, D3D11.Device_GetDeviceRemovedReason))(chain.Device);
        if (removed != ComCall.S_OK) return $"device removed (0x{removed:X8})";

        var current = ((delegate* unmanaged[Stdcall]<nint, int>)
            ComCall.Method(chain.Factory, Dxgi.Factory1_IsCurrent))(chain.Factory);
        if (current == 0) return "adapters changed (factory no longer current)";

        if (!TryReadOutput(chain.Output, out var output)) return "output GetDesc failed";

        if (output.Monitor != hMonitor || !output.Attached || output != chain.BuiltOutput)
            return $"output changed ({chain.BuiltOutput} → {output})";

        var mode = ReadMode(chain.Duplication);
        if (mode != chain.BuiltMode) return $"mode changed ({chain.BuiltMode} → {mode})";

        return null;
    }

    // ── Steps ────────────────────────────────────────────────────────────

    /// <summary>
    /// Builds a whole set for one output. On <c>false</c> the caller disposes whatever part was
    /// made; <see cref="LastStep"/> says where it stopped.
    /// </summary>
    private bool TryBuild(Chain chain)
    {
        LastStep = "looking for an output";
        if (!TryFindOutput(chain.Monitor, ref chain.Factory, ref chain.Adapter, ref chain.Output))
            return false;

        LastStep = "D3D11 device";
        if (!TryCreateDevice(chain.Adapter, ref chain.Device, ref chain.Context))
            return false;

        LastStep = "IDXGIOutput1";
        if (ComCall.QueryInterface(chain.Output, Dxgi.IID_IDXGIOutput1, out chain.Output1) < 0)
            return false;

        LastStep = "DuplicateOutput";
        nint duplication = 0;
        var hr = ((delegate* unmanaged[Stdcall]<nint, nint, nint*, int>)
            ComCall.Method(chain.Output1, Dxgi.Output1_DuplicateOutput))(
                chain.Output1, chain.Device, &duplication);

        // Careful: E_ACCESSDENIED means the secure desktop (UAC/lock screen) is in front, and
        // NOT_CURRENTLY_AVAILABLE means the limit of simultaneous duplications was hit, which does
        // happen when Teams/Zoom is sharing. Both are temporary; this slot will be captured via
        // GDI, and the next capture tries to build the set again.
        if (hr < 0)
        {
            LastStep = $"DuplicateOutput failed (0x{hr:X8})";
            return false;
        }

        chain.Duplication = duplication;

        LastStep = "reading the output and mode";
        if (!TryReadOutput(chain.Output, out chain.BuiltOutput)) return false;
        chain.BuiltMode = ReadMode(chain.Duplication);

        return true;
    }

    /// <summary>
    /// One capture from a set, fresh or kept.
    ///
    /// <paramref name="healthy"/> says whether the set may be kept: <c>true</c> for an image, and
    /// for "nothing changed on screen" (a timeout is the normal answer of a persistent duplication
    /// on a still screen, not a fault of the set). Everything else is <c>false</c>, and the caller
    /// throws the set away.
    ///
    /// Careful: <b>discarding a set on every timeout would bring the leak straight back</b>, worst
    /// of all exactly when the screen is frozen and fingerprints come every 5 seconds.
    /// </summary>
    private CapturedFrame? Attempt(Chain chain, MonitorInfo monitor, out bool healthy)
    {
        healthy = false;

        nint desktop = 0, texture = 0;
        var held = false;
        var mapped = false;

        try
        {
            var turns = PixelCopy.TurnsForRotation(chain.BuiltMode.Rotation);

            LastStep = "waiting for a frame";
            var got = TryAcquire(chain.Duplication, out var info, ref desktop);

            if (got == Acquired.NoChange)
            {
                healthy = true;
                return null;
            }

            if (got == Acquired.Failed) return null;

            // From here on a frame is held: the finally releases it on every path that leaves
            // before the explicit release below.
            held = true;

            LastStep = $"got a frame (accumulated={info.AccumulatedFrames}, " +
                       $"present={info.LastPresentTime}, drm={info.ProtectedContentMaskedOut})";

            if (ComCall.QueryInterface(desktop, D3D11.IID_ID3D11Texture2D, out texture) < 0)
            {
                LastStep += " · the surface is not a Texture2D";
                return null;
            }

            D3D11_TEXTURE2D_DESC desc;
            ((delegate* unmanaged[Stdcall]<nint, D3D11_TEXTURE2D_DESC*, void>)
                ComCall.Method(texture, D3D11.Texture2D_GetDesc))(texture, &desc);

            // On an HDR monitor the format may be R16G16B16A16_FLOAT. Forcing the bytes to be read
            // as BGRA would give colourful garbage, which looks just like "an image was taken". So
            // when we do not understand it, the rule is not to touch it.
            //
            // Careful: this too throws the set away ("any failure"). On an HDR screen that means
            // one rebuild per attempt, but EngineFault stays true, so after three of them
            // EngineFallbackPolicy rests DXGI for 30 minutes: a handful of chains an hour, not
            // thousands a day.
            if (desc.Format != D3D11.FormatB8G8R8A8Unorm)
            {
                LastStep += $" · format {desc.Format} is not BGRA (HDR?)";
                return null;
            }

            if (chain.Staging == 0)
            {
                if (!TryCreateStaging(chain.Device, desc, ref chain.Staging))
                {
                    LastStep += " · staging texture could not be created";
                    return null;
                }

                chain.StagingDesc = desc;
            }
            else if (desc.Width != chain.StagingDesc.Width
                     || desc.Height != chain.StagingDesc.Height
                     || desc.Format != chain.StagingDesc.Format)
            {
                // Careful: CopyResource between textures of different sizes silently does nothing,
                // and the old pixels in the staging texture would be returned as a new image.
                LastStep += $" · surface is {desc.Width}×{desc.Height}, staging was " +
                            $"{chain.StagingDesc.Width}×{chain.StagingDesc.Height}";
                return null;
            }

            ((delegate* unmanaged[Stdcall]<nint, nint, nint, void>)
                ComCall.Method(chain.Context, D3D11.Context_CopyResource))(
                    chain.Context, chain.Staging, texture);

            // Careful: release **right after** the copy, before Map. Releasing invalidates the
            // desktop surface; releasing earlier would leave nothing to copy. The copy is already
            // queued, so a failure here does not spoil this image, but it does mean the set is no
            // longer trustworthy.
            held = false;
            var released = ((delegate* unmanaged[Stdcall]<nint, int>)
                ComCall.Method(chain.Duplication, Dxgi.Duplication_ReleaseFrame))(chain.Duplication);

            D3D11_MAPPED_SUBRESOURCE map;
            var hr = ((delegate* unmanaged[Stdcall]<nint, nint, uint, uint, uint, D3D11_MAPPED_SUBRESOURCE*, int>)
                ComCall.Method(chain.Context, D3D11.Context_Map))(
                    chain.Context, chain.Staging, 0, D3D11.MapRead, 0, &map);

            if (hr < 0)
            {
                LastStep += $" · Map failed (0x{hr:X8})";
                return null;
            }

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

            healthy = released >= 0;
            if (!healthy) LastStep += $" · ReleaseFrame failed (0x{released:X8})";

            return new CapturedFrame(
                pixels, finalW, finalH, finalW * PixelCopy.BytesPerPixel, monitor, Name)
            {
                ProtectedContentMasked = info.ProtectedContentMaskedOut != 0,
            };
        }
        finally
        {
            // Careful: if Unmap is skipped, the staging texture stays mapped, and now that it is
            // kept, every later Map on it fails. The mistake shows up weeks later, as some other
            // symptom.
            if (mapped)
            {
                ((delegate* unmanaged[Stdcall]<nint, nint, uint, void>)
                    ComCall.Method(chain.Context, D3D11.Context_Unmap))(chain.Context, chain.Staging, 0);
            }

            ComCall.Release(ref texture);
            ComCall.Release(ref desktop);

            // Careful: a frame left held makes the next AcquireNextFrame on this (kept) duplication
            // fail with DXGI_ERROR_INVALID_CALL. The set is thrown away on these paths anyway, but
            // releasing here keeps it correct even if one of them is ever made "healthy".
            if (held)
            {
                ((delegate* unmanaged[Stdcall]<nint, int>)
                    ComCall.Method(chain.Duplication, Dxgi.Duplication_ReleaseFrame))(chain.Duplication);
            }
        }
    }

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

    /// <summary>
    /// The current <c>DXGI_OUTPUT_DESC</c> of an output, reduced to what <see cref="WhyStale"/>
    /// compares.
    /// </summary>
    private static bool TryReadOutput(nint output, out OutputState state)
    {
        DXGI_OUTPUT_DESC desc;
        var hr = ((delegate* unmanaged[Stdcall]<nint, DXGI_OUTPUT_DESC*, int>)
            ComCall.Method(output, Dxgi.Output_GetDesc))(output, &desc);

        if (hr < 0)
        {
            state = default;
            return false;
        }

        var r = desc.DesktopCoordinates;
        state = new OutputState(
            desc.Monitor, r.Left, r.Top, r.Right, r.Bottom, desc.AttachedToDesktop != 0, desc.Rotation);
        return true;
    }

    /// <summary>
    /// The duplicated surface's size and how far the display is rotated
    /// (<c>DXGI_MODE_ROTATION</c>).
    /// </summary>
    private static ModeState ReadMode(nint duplication)
    {
        DXGI_OUTDUPL_DESC desc;
        ((delegate* unmanaged[Stdcall]<nint, DXGI_OUTDUPL_DESC*, void>)
            ComCall.Method(duplication, Dxgi.Duplication_GetDesc))(duplication, &desc);

        return new ModeState(desc.ModeDesc.Width, desc.ModeDesc.Height, desc.Rotation);
    }

    /// <summary>What <see cref="TryAcquire"/> came back with.</summary>
    private enum Acquired
    {
        /// <summary>A frame with a real image is held: the caller must release it.</summary>
        Frame,

        /// <summary>Nothing changed on screen: no frame is held, and the set is healthy.</summary>
        NoChange,

        /// <summary>An error: no frame is held, and the set must go.</summary>
        Failed,
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
    ///
    /// Careful: that empty first frame happens only on a freshly built duplication. On a kept one,
    /// a still screen simply times out, and a frame (whose surface is the <b>whole</b> desktop, not
    /// a diff) comes only once something changed since the previous release. Both end the same
    /// way: <see cref="Acquired.NoChange"/>, "no change on screen — falling back to GDI". The old
    /// staging pixels are deliberately <b>not</b> handed out as a "still the same" image: GDI gives
    /// a fresh one of a still screen perfectly, and a stale copy passed off as new is the kind of
    /// mistake nobody would ever notice.
    /// </summary>
    private Acquired TryAcquire(nint duplication, out DXGI_OUTDUPL_FRAME_INFO info, ref nint desktop)
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
                return Acquired.Failed;
            }

            // whether there really is an image: it is enough if either of the two is non-zero
            if (fi.AccumulatedFrames > 0 || fi.LastPresentTime != 0)
            {
                info = fi;
                desktop = res;
                return Acquired.Frame;
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
        return Acquired.NoChange;
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

    /// <summary>
    /// Releases every kept set. After this, <see cref="Capture"/> answers <c>null</c> (not the
    /// engine's fault), so a capture racing with shutdown falls to GDI instead of touching freed COM
    /// objects.
    ///
    /// Careful: this was empty while nothing outlived a capture. Now it is the only place the kept
    /// duplications are given back; the owner chain is
    /// <c>AgentHost.DisposeAsync → ScreenCaptureService → FallbackCapturer → here</c>.
    /// </summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;

            foreach (var chain in _chains.Values) chain.Dispose();
            _chains.Clear();
        }
    }
}
