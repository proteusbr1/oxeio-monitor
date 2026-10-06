namespace oXeio.Core.Capture;

/// <summary>
/// Decides the random screenshot times (A01).
///
/// Every 5 minutes is a "slot", and within the slot the picture is taken at a <b>random</b>
/// second. So 12 pictures an hour arrive regularly, but nobody can know in advance
/// <b>exactly when</b>: that is the core of the whole scheme.
///
/// <code>
/// [09:00–09:05] → 09:03:47      [09:15–09:20] → 09:19:55
/// [09:05–09:10] → 09:06:12      [09:20–09:25] → skipped (was idle)
/// </code>
/// </summary>
public sealed class SlotScheduler
{
    private readonly TimeSpan _slot;
    private readonly Random _rng;

    public SlotScheduler(int slotMinutes, Random? rng = null)
    {
        if (slotMinutes <= 0) throw new ArgumentOutOfRangeException(nameof(slotMinutes));
        _slot = TimeSpan.FromMinutes(slotMinutes);
        _rng = rng ?? Random.Shared;
    }

    public sealed record Slot(DateTimeOffset SlotStart, DateTimeOffset FireAt);

    /// <summary>
    /// The slot after <paramref name="after"/> and the moment within it to take the picture.
    /// </summary>
    public Slot Next(DateTimeOffset after)
    {
        var slotStart = FloorToSlot(after) + _slot;
        var offset = _rng.NextDouble() * _slot.TotalSeconds;
        return new Slot(slotStart, slotStart + TimeSpan.FromSeconds(offset));
    }

    /// <summary>The start of the slot that contains that moment.</summary>
    public DateTimeOffset FloorToSlot(DateTimeOffset t)
    {
        var ticks = t.UtcTicks - (t.UtcTicks % _slot.Ticks);
        return new DateTimeOffset(ticks, TimeSpan.Zero);
    }
}
