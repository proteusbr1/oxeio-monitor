namespace oXeio.Core.Agent;

/// <summary>
/// The <b>metadata</b> of one screenshot: the <c>meta</c> part of the multipart body of
/// <c>POST /agent/screenshots</c>. The image bytes are not here.
///
/// Images never go into a queue row. 288 slots x 3 monitors x ~200 KB is about 170 MB per
/// day; storing that as a blob inside the DB would make every VACUUM and backup terrible, and
/// reading one row would pull a whole image into RAM. The bytes live in a separate file on
/// disk, and the row only holds <see cref="OutboxItem.FilePath"/>.
/// </summary>
public sealed record ScreenshotRecord
{
    public required Guid ClientUuid { get; init; }

    /// <summary>Start of the 5-minute slot: supplied by <see cref="oXeio.Core.Capture.SlotScheduler"/>.</summary>
    public required DateTimeOffset SlotStart { get; init; }

    /// <summary>The actual random moment within the slot.</summary>
    public required DateTimeOffset CapturedAt { get; init; }

    /// <summary>0-based. The server accepts only 0 to 7.</summary>
    public required int MonitorIndex { get; init; }

    public int? Width { get; init; }
    public int? Height { get; init; }

    /// <summary>The foreground process at the moment of capture, e.g. <c>excel.exe</c>.</summary>
    public string? ActiveApp { get; init; }

    /// <summary>At most 1000 characters.</summary>
    public string? ActiveTitle { get; init; }
}
