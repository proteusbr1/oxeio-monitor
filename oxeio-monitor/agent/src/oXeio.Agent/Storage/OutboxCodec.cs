using System.Text.Json;
using System.Text.Json.Serialization;

using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Storage;

/// <summary>
/// How records are stored in the outbox queue.
///
/// Careful: <b>this is not the server's wire format</b>; that is <c>Sync/SyncWire.cs</c>.
/// The two are deliberately separate, so that when the server contract changes, old rows
/// left on disk do not become unreadable.
///
/// Important: <b>the most critical rule is that old rows must always be readable.</b>
/// The agent updates at night, and right then a PC may be holding a week of offline backlog.
/// If the new version cannot read it, that staff member's whole week of hours is lost, and
/// nobody notices because everything looks normal from the server's side.
///
/// So:
/// <list type="bullet">
/// <item>Unknown properties are ignored (new fields written by a newer agent).</item>
/// <item>New fields are always <b>nullable or have a default</b>, never required.</item>
/// <item>A field must <b>never</b> be renamed or removed, only added.</item>
/// </list>
/// </summary>
internal static class OutboxCodec
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,

        // Rows written by an older agent may contain new fields; just drop them,
        // there is nothing to throw about.
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip,

        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static string Encode<T>(T record) where T : class =>
        JsonSerializer.Serialize(record, Options);

    /// <summary>
    /// Returns <c>null</c> when it cannot be read, not an exception.
    ///
    /// Careful: this is deliberate. A corrupt row (half written when the power went, or some
    /// future format) that threw would sit at the head of the queue and <b>block everything
    /// behind it forever</b>. Now the caller can skip that one row and carry on.
    /// </summary>
    public static T? Decode<T>(string payload) where T : class
    {
        if (string.IsNullOrWhiteSpace(payload)) return null;

        try
        {
            return JsonSerializer.Deserialize<T>(payload, Options);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>Which type to read the row as, based on its kind.</summary>
    public static object? Decode(OutboundKind kind, string payload) => kind switch
    {
        OutboundKind.Segment => Decode<ActivitySegment>(payload),
        OutboundKind.AppUsage => Decode<AppUsageRecord>(payload),
        OutboundKind.Event => Decode<AgentEventRecord>(payload),
        OutboundKind.Screenshot => Decode<ScreenshotRecord>(payload),
        _ => null,
    };

    // ── easy paths for enqueueing ───────────────────────────────────────────

    public static OutboxItem Item(ActivitySegment s, DateTimeOffset now) =>
        Wrap(s.ClientUuid, OutboundKind.Segment, Encode(s), now);

    public static OutboxItem Item(AppUsageRecord a, DateTimeOffset now) =>
        Wrap(a.ClientUuid, OutboundKind.AppUsage, Encode(a), now);

    public static OutboxItem Item(AgentEventRecord e, DateTimeOffset now) =>
        Wrap(e.ClientUuid, OutboundKind.Event, Encode(e), now);

    /// <summary>
    /// Screenshot bytes do not go into the DB; the row holds only the file path.
    /// <paramref name="fileBytes"/> is for the budget accounting, so that when the disk fills
    /// up the screenshots are trimmed first.
    /// </summary>
    public static OutboxItem Item(
        ScreenshotRecord s, string webpPath, long fileBytes, DateTimeOffset now) =>
        new()
        {
            ClientUuid = s.ClientUuid,
            Kind = OutboundKind.Screenshot,
            EnqueuedAt = now,
            Payload = Encode(s),
            FilePath = webpPath,
            SizeBytes = fileBytes,
        };

    private static OutboxItem Wrap(
        Guid uuid, OutboundKind kind, string payload, DateTimeOffset now) =>
        new()
        {
            ClientUuid = uuid,
            Kind = kind,
            EnqueuedAt = now,
            Payload = payload,
            SizeBytes = payload.Length,
        };
}
