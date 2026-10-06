namespace oXeio.Core.Agent;

/// <summary>
/// Each outbox row is for exactly one endpoint; this enum says which.
///
/// The declaration order is deliberately not used in <see cref="OutboxBudget"/> to decide
/// "which can be dropped first"; that has its own separate rank, because reordering the
/// enum would silently delete the wrong things.
///
/// Careful: the enum's name is stored in SQLite as <b>text</b>, not as a number. Storing a
/// number would mean that adding a member in the middle someday sends old rows to a different
/// endpoint, and nobody would notice.
/// </summary>
public enum OutboundKind
{
    /// <summary><c>POST /agent/segments</c> — payload <see cref="oXeio.Core.Models.ActivitySegment"/></summary>
    Segment,

    /// <summary><c>POST /agent/app-usage</c> — payload <see cref="AppUsageRecord"/></summary>
    AppUsage,

    /// <summary><c>POST /agent/events</c> — payload <see cref="AgentEventRecord"/></summary>
    Event,

    /// <summary>
    /// <c>POST /agent/screenshots</c> — payload <see cref="ScreenshotRecord"/>,
    /// and the actual bytes are on disk (<see cref="OutboxItem.FilePath"/>).
    /// </summary>
    Screenshot,
}
