namespace oXeio.Core.Tracking;

/// <summary>
/// "How long since the last input": this one subtraction is the basis of the whole hours count.
///
/// Kept apart from Win32 so it can be tested. <c>GetLastInputInfo</c> only gives a raw
/// number; the rule for what to do with two such numbers is here.
/// </summary>
public static class IdleMath
{
    /// <summary>
    /// A result larger than this means the subtraction went the wrong way (a timestamp in the
    /// future), not a real 49 days of inactivity.
    /// </summary>
    public const uint FutureGuard = 0x8000_0000u;

    /// <summary>
    /// <paramref name="nowTicks32"/> and <paramref name="lastInputTicks32"/> are both on
    /// <c>GetTickCount</c>'s 32-bit clock. Deliberately <c>unchecked</c>: even when the
    /// clock wraps around after 49.7 days, modular subtraction gives the right answer by itself.
    /// </summary>
    /// <param name="clampedFuture">
    /// Whether the last input's time appeared to be later than "now". Microsoft says dwTime is
    /// "not guaranteed to be incremental"; being just 5 seconds ahead would make this
    /// subtraction give a bogus 49 days of inactivity, and that staff member's whole day of
    /// work would vanish. Using 64 bits does not fix it either: the problem is not wrap but
    /// unsigned underflow.
    /// </param>
    public static TimeSpan Elapsed(uint nowTicks32, uint lastInputTicks32, out bool clampedFuture)
    {
        var delta = unchecked(nowTicks32 - lastInputTicks32);

        clampedFuture = delta > FutureGuard;
        if (clampedFuture) delta = 0u;

        return TimeSpan.FromMilliseconds(delta);
    }

    /// <inheritdoc cref="Elapsed(uint, uint, out bool)"/>
    public static TimeSpan Elapsed(uint nowTicks32, uint lastInputTicks32) =>
        Elapsed(nowTicks32, lastInputTicks32, out _);
}
