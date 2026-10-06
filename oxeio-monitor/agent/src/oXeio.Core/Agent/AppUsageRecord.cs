using oXeio.Core.Models;

namespace oXeio.Core.Agent;

/// <summary>
/// A slice of app/site usage: one element of <c>items[]</c> in <c>POST /agent/app-usage</c>.
///
/// Like <see cref="oXeio.Core.Models.ActivitySegment"/>, the <see cref="ClientUuid"/> is created
/// in the agent and kept in the queue, so retries send the same id.
/// </summary>
public sealed record AppUsageRecord
{
    public required Guid ClientUuid { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public required DateTimeOffset EndedAt { get; init; }

    /// <summary>The server accepts only 0 to 86400; it splits across days itself.</summary>
    public required int DurationSec { get; init; }

    /// <summary>E.g. <c>chrome.exe</c>. At most 260 characters (Windows MAX_PATH).</summary>
    public required string ProcessName { get; init; }

    /// <summary>The executable's FileDescription, e.g. "Google Chrome". Null if not found.</summary>
    public string? AppName { get; init; }

    /// <summary>At most 1000 characters; the server returns 400 for more.</summary>
    public string? WindowTitle { get; init; }

    /// <summary>
    /// Domain only, <b>never the full URL</b> (ADR-013). "facebook.com" is fine,
    /// "facebook.com/messages/t/12345" is not. Keeping the path or query would turn this from
    /// app tracking into browsing-history surveillance.
    /// </summary>
    public string? Domain { get; init; }

    public bool? IsBrowser { get; init; }

    /// <summary>
    /// <b>R22a</b>: the state in which this slice was observed.
    ///
    /// App usage used to be recorded <b>only while ACTIVE</b>, so this field was not needed.
    /// But that would lose the answer to one question forever: "what was in front during this
    /// idle time?", which is the only clue for recognizing meetings (in a Zoom call the keyboard
    /// is quiet, yet the person is working).
    ///
    /// Defaults to <see cref="SegmentState.Active"/>, because old agents do not send this field
    /// and everything they sent was ACTIVE by definition. The server has the same default, so the
    /// meaning of old rows does not change.
    ///
    /// <b>This is not something to count.</b> Slices seen while idle do not go into reports or
    /// D07/D08: every place that reads them filters on <c>segment_state = 'active'</c>. Otherwise
    /// "leaving Excel open and going to lunch" would count as work, and that rule is the heart of
    /// this tracker.
    /// </summary>
    public SegmentState State { get; init; } = SegmentState.Active;
}
