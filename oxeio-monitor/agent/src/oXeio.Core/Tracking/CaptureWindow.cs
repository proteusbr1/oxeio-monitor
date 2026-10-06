using oXeio.Core.Time;

namespace oXeio.Core.Tracking;

/// <summary>
/// The time window for taking pictures (ADR-011c).
///
/// This is <b>not</b> a limit on <b>counting time</b>. If someone works at 2 a.m. their hours
/// are counted in full; only no picture is taken. That is why the class is named
/// CaptureWindow and not ShiftWindow: there is no such thing as a shift.
/// </summary>
public sealed class CaptureWindow
{
    private readonly TimeOnly? _from;
    private readonly TimeOnly? _to;

    /// <param name="from">E.g. 07:00. If null, pictures are taken 24 hours a day.</param>
    /// <param name="to">E.g. 23:00. This exact moment is <b>excluded</b>.</param>
    public CaptureWindow(TimeOnly? from, TimeOnly? to)
    {
        _from = from;
        _to = to;
    }

    public static CaptureWindow Always => new(null, null);

    public static CaptureWindow Default => new(new TimeOnly(7, 0), new TimeOnly(23, 0));

    public bool Allows(DateTimeOffset instant)
    {
        if (_from is null || _to is null) return true;

        var now = DhakaTime.LocalTimeOf(instant);

        // A window that crosses midnight, like 23:00 → 07:00, must work too
        return _from <= _to
            ? now >= _from && now < _to
            : now >= _from || now < _to;
    }
}
