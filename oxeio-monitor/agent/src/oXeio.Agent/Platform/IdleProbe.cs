using System.Runtime.InteropServices;
using System.Runtime.Versioning;

using oXeio.Agent.Native;
using oXeio.Core.Tracking;

namespace oXeio.Agent.Platform;

/// <summary>
/// "How long ago was the last input": one job only.
///
/// <b>Stateless:</b> calculated from zero each time, nothing is accumulated. If a tick is missed,
/// only that second's precision is lost; the accounting is not damaged.
///
/// The calculation rule is in <see cref="IdleMath"/>, because that can be tested; here we only
/// fetch the raw number from Win32.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class IdleProbe
{
    internal readonly record struct Sample(
        bool Valid,
        TimeSpan SinceLastInput,
        ulong BiasedMs,
        ulong UnbiasedMs,
        uint RawDwTime,
        uint RawNow32,
        /// <summary>Whether the last input time appeared to be later than "now".</summary>
        bool ClampedFuture,
        int Win32Error);

    private LASTINPUTINFO _lii;

    public Sample Read()
    {
        // must be set every time: Windows really does validate this
        _lii.cbSize = 8;

        var biased = Kernel32.GetTickCount64();
        var unbiased = ReadUnbiasedMs();

        if (!User32.GetLastInputInfo(ref _lii))
        {
            // Careful: no default value may be put in. dwTime would be 0, and using it would
            // compute inactivity as "since the PC was switched on". The sample is dropped.
            return new Sample(false, TimeSpan.Zero, biased, unbiased, 0, 0, false,
                Marshal.GetLastPInvokeError());
        }

        // dwTime runs on the 32-bit GetTickCount clock, and the low 32 bits of GetTickCount64 are
        // that same clock, so narrow it and use modular subtraction
        var now32 = unchecked((uint)biased);
        var elapsed = IdleMath.Elapsed(now32, _lii.dwTime, out var clamped);

        return new Sample(true, elapsed, biased, unbiased, _lii.dwTime, now32, clamped, 0);
    }

    private static ulong ReadUnbiasedMs() =>
        Kernel32.QueryUnbiasedInterruptTime(out var t) ? t / 10_000UL : 0UL;
}
