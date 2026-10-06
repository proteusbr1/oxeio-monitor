using oXeio.Core.Time;

namespace oXeio.Core.Models;

/// <summary>
/// A closed segment: goes to the server in <c>POST /agent/segments</c>.
///
/// <see cref="ClientUuid"/> is created in the agent and kept in the queue, so retries send
/// the same id and the server can drop duplicates (section 2.1(d)).
/// </summary>
public sealed record ActivitySegment
{
    public required Guid ClientUuid { get; init; }
    public required SegmentState State { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public required DateTimeOffset EndedAt { get; init; }

    /// <summary>
    /// Measured from the monotonic clock, so this number is intact even if the PC's clock changes.
    /// </summary>
    public required int DurationSec { get; init; }

    /// <summary>0 to 100: how active the person was in this slice. Not keylogging (B13).</summary>
    public int? InputScore { get; init; }

    public DateOnly WorkDate => WorkTime.WorkDateOf(StartedAt);

    /// <summary>Only <see cref="SegmentState.Active"/> is added to the hours calculation.</summary>
    public bool CountsAsWork => State == SegmentState.Active;
}
