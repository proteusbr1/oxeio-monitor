using System.Globalization;

using oXeio.Core.Tracking;

namespace oXeio.Core.Agent;

/// <summary>
/// Config from the server, returned by <c>GET /agent/config</c> and by enroll.
/// An exact mirror of <c>AgentConfig</c> in the server's <c>agent-config.service.ts</c>.
///
/// Important: this is the agent's <b>only</b> config type. Do not create another for your
/// own module: with two, one module would run on an old idleThreshold and the other on the
/// new one, and their counted hours would not match.
///
/// Fields are non-nullable but <c>init</c>: a config is built once and never changes; to
/// change it, create a new instance. If fields changed midway, the tracking loop and the
/// capture loop would see two different configs in the same tick.
/// </summary>
public sealed record AgentConfig
{
    public required int IdleThresholdSec { get; init; }

    public required int SlotMinutes { get; init; }

    /// <summary><c>"HH:MM"</c>. Null means screenshots are taken 24 hours a day (ADR-011c).</summary>
    public string? ScreenshotFrom { get; init; }

    /// <inheritdoc cref="ScreenshotFrom"/>
    public string? ScreenshotTo { get; init; }

    /// <summary>Always <c>"Asia/Dhaka"</c> in v1, see <see cref="oXeio.Core.Time.DhakaTime"/>.</summary>
    public required string Timezone { get; init; }

    /// <summary>
    /// Minutes east of UTC for <see cref="Timezone"/> (Asia/Dhaka = 360). The
    /// server only accepts zones without DST, so this one number is enough.
    /// <c>null</c> from a server older than the field — keep the current offset.
    /// </summary>
    public int? UtcOffsetMinutes { get; init; }

    public required double MonthlyTargetHours { get; init; }

    public required int HeartbeatSec { get; init; }

    public required AppTrackingConfig AppTracking { get; init; }

    public required ScreenshotConfig Screenshot { get; init; }

    /// <summary>
    /// Used before enrolling, or when the config cannot be read.
    ///
    /// Careful: tracking <b>must not stop</b> when no config is available, or a server outage
    /// would zero everyone's hours. Keep running on the defaults; they change when a config arrives.
    /// </summary>
    public static AgentConfig Default => new()
    {
        IdleThresholdSec = 60,
        SlotMinutes = 5,
        ScreenshotFrom = "07:00",
        ScreenshotTo = "23:00",
        Timezone = "Asia/Dhaka",
        UtcOffsetMinutes = 360,
        MonthlyTargetHours = 208,
        HeartbeatSec = 30,
        AppTracking = new AppTrackingConfig { Enabled = true, MinDurationSec = 5 },
        Screenshot = new ScreenshotConfig
        {
            Enabled = true,
            Format = "webp",
            Quality = 70,
            MaxWidth = 1920,
            AllMonitors = true,
        },
    };

    /// <summary>
    /// <see cref="ScreenshotFrom"/>/<see cref="ScreenshotTo"/> → <see cref="CaptureWindow"/>.
    ///
    /// Written once here so that modules do not each parse "HH:MM" their own way: one
    /// <c>DateTime.Parse</c> would mean something different under a Bangladeshi locale.
    /// </summary>
    public CaptureWindow ToCaptureWindow() =>
        new(ParseHhMm(ScreenshotFrom), ParseHhMm(ScreenshotTo));

    /// <summary>A bad or missing value gives null, meaning "no limit", not a crash.</summary>
    public static TimeOnly? ParseHhMm(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        // The ':' in the format is the culture-dependent time separator. Without
        // InvariantCulture it would look for '.' in some locales and always return null.
        return TimeOnly.TryParseExact(
            value, @"HH\:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : null;
    }
}

public sealed record AppTrackingConfig
{
    public required bool Enabled { get; init; }

    /// <summary>Apps shorter than this are not counted, to drop alt-tab noise.</summary>
    public required int MinDurationSec { get; init; }
}

public sealed record ScreenshotConfig
{
    /// <summary>
    /// <c>false</c> = the work policy turned screenshots off: no image is
    /// taken, written or sent. <c>null</c> comes from a server older than the
    /// field and means on, as before.
    ///
    /// ⚠️ The jiggler check keeps sampling the screen either way
    /// (<see cref="oXeio.Core.Capture.CaptureGate.Verdict.DisabledByPolicy"/>).
    /// </summary>
    public bool? Enabled { get; init; }

    /// <summary><see cref="Enabled"/>, with "not sent" read as on.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsEnabled => Enabled != false;

    /// <summary>The server only accepts <c>"webp"</c>; anything else gets a 415.</summary>
    public required string Format { get; init; }

    /// <summary>0 to 100.</summary>
    public required int Quality { get; init; }

    /// <summary>Wider images are scaled down to this width.</summary>
    public required int MaxWidth { get; init; }

    /// <summary>A separate image per monitor, or the primary only.</summary>
    public required bool AllMonitors { get; init; }
}
