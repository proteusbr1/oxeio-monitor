namespace oXeio.Core.Models;

/// <summary>
/// Only three states (ADR-011d).
///
/// There is no BREAK / LUNCH: someone who leaves for lunch becomes <see cref="Idle"/> after 1 minute anyway.
/// There is no MEETING: staff have no button to press.
/// There is no OFF_SHIFT: there is no time restriction, all 24 hours are counted.
///
/// Only <see cref="Active"/> counts as work.
/// </summary>
public enum SegmentState
{
    Active,
    Idle,
    Locked,
}
