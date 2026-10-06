using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Sync;

/// <summary>
/// The exact shape of what goes on the wire; Core's records are not serialized directly.
///
/// Important: <b>why this extra layer:</b> System.Text.Json writes <b>every</b> public getter,
/// computed properties included. <see cref="ActivitySegment"/> has
/// <see cref="ActivitySegment.WorkDate"/> and <see cref="ActivitySegment.CountsAsWork"/>;
/// sent directly, <c>workDate</c> and <c>countsAsWork</c> would also end up in the JSON. With
/// <c>forbidNonWhitelisted</c> on in NestJS an unknown field means a 400, and a 400 means
/// <see cref="SyncOutcome.Permanent"/>, so 500 segments would be deleted for good.
/// Someone adding one harmless computed property to Core would trigger it, and there would be
/// no compiler warning anywhere.
///
/// So the rule: <b>every field that is sent to the server is written by hand here.</b>
/// (In the other direction, when reading, deserializing straight into Core's records is safe;
/// STJ drops unknown fields anyway.)
/// </summary>
internal static class SyncWire
{
    private static readonly char[] PathStarters = ['/', '?', '#'];

    // ── segments ────────────────────────────────────────────────────────────

    internal sealed record SegmentsEnvelope
    {
        public required IReadOnlyList<SegmentDto> Segments { get; init; }
    }

    internal sealed record SegmentDto
    {
        public required Guid ClientUuid { get; init; }
        public required string State { get; init; }
        public required DateTimeOffset StartedAt { get; init; }
        public required DateTimeOffset EndedAt { get; init; }
        public required int DurationSec { get; init; }
        public int? InputScore { get; init; }
    }

    internal static SegmentsEnvelope Segments(IReadOnlyList<ActivitySegment> segments)
    {
        var list = new List<SegmentDto>(segments.Count);
        foreach (var s in segments)
        {
            list.Add(new SegmentDto
            {
                ClientUuid = s.ClientUuid,
                State = StateToWire(s.State),
                StartedAt = s.StartedAt,
                EndedAt = s.EndedAt,
                DurationSec = s.DurationSec,
                InputScore = s.InputScore,
            });
        }

        return new SegmentsEnvelope { Segments = list };
    }

    /// <summary>
    /// Careful: <b>the server's enum is lowercase</b>: <c>active / idle / locked</c>.
    /// See <c>enum SegmentState</c> in <c>server/prisma/schema.prisma</c>;
    /// both the Postgres enum and <c>@IsEnum()</c> are case-sensitive.
    ///
    /// Sending C#'s <c>SegmentState.Active</c> directly would send <c>"Active"</c>, and
    /// uppercase <c>"ACTIVE"</c> gives the same result: <b>400</b>. And a 400 means
    /// <see cref="SyncOutcome.Permanent"/>, so the batch would be <b>deleted</b> instead of
    /// retried. One wrong letter would lose a month of payroll data.
    ///
    /// The conversion lives in this one place; segments and heartbeat both use it.
    /// </summary>
    internal static string StateToWire(SegmentState state) => state switch
    {
        SegmentState.Active => "active",
        SegmentState.Idle => "idle",
        SegmentState.Locked => "locked",

        // Careful: no default for an unknown state. This used to return "ACTIVE", so any new
        // state added later would silently count as **work time**. Stopping here is better
        // than sending wrong data to the server.
        _ => throw new ArgumentOutOfRangeException(
            nameof(state), state, "No server representation is defined for this state"),
    };

    // ── app usage ───────────────────────────────────────────────────────────

    internal sealed record AppUsageEnvelope
    {
        public required IReadOnlyList<AppUsageDto> Items { get; init; }
    }

    internal sealed record AppUsageDto
    {
        public required Guid ClientUuid { get; init; }
        public required DateTimeOffset StartedAt { get; init; }
        public required DateTimeOffset EndedAt { get; init; }
        public required int DurationSec { get; init; }
        public required string ProcessName { get; init; }
        public string? AppName { get; init; }
        public string? WindowTitle { get; init; }
        public string? Domain { get; init; }
        public bool? IsBrowser { get; init; }

        /**
         * Which state the interval was observed in (`active` / `idle`).
         *
         * Careful: a lowercase string, because the server's enum is too (`SegmentState`).
         * `.ToString()` would send `Active` and `@IsEnum` would return a 400, and a 400
         * means Permanent, so the whole batch would be deleted.
         */
        public required string State { get; init; }
    }

    internal static AppUsageEnvelope AppUsage(IReadOnlyList<AppUsageRecord> items)
    {
        var list = new List<AppUsageDto>(items.Count);
        foreach (var i in items)
        {
            list.Add(new AppUsageDto
            {
                ClientUuid = i.ClientUuid,
                StartedAt = i.StartedAt,
                EndedAt = i.EndedAt,
                DurationSec = i.DurationSec,
                // Careful: exceeding the server's @MaxLength gives the whole batch a 400, and
                // a 400 means Permanent, so data is deleted. Hence the length is capped here.
                ProcessName = Clamp(i.ProcessName, 260)!,
                AppName = Clamp(i.AppName, 260),
                WindowTitle = Clamp(i.WindowTitle, 1000),
                Domain = Clamp(DomainOnly(i.Domain), 260),
                IsBrowser = i.IsBrowser,
                State = i.State.ToString().ToLowerInvariant(),
            });
        }

        return new AppUsageEnvelope { Items = list };
    }

    /// <summary>
    /// Trims to within the server's limits.
    ///
    /// Careful: none of these strings is written by us: <c>appName</c> comes from the
    /// executable's version resource, <c>domain</c> from the address bar. Any long value can
    /// get in, and one long value would give the whole batch a 400. Trimmed data is
    /// incomplete, but better than lost data.
    /// </summary>
    private static string? Clamp(string? value, int max) =>
        value is null || value.Length <= max ? value : value[..max];

    /// <summary>
    /// The last guard: a full URL never goes onto the network, only the domain.
    ///
    /// Extracting the domain from the browser title/URL is the app-tracking module's job, but
    /// the prohibition (never store a full URL) is a <b>hard</b> rule of the system.
    /// If a bug in one module let <c>https://bank.com/account/12345?token=…</c> through, it
    /// would end up in the server's database with no way to take it back. So it is trimmed at
    /// the door, even knowing "this is not supposed to happen".
    /// </summary>
    internal static string? DomainOnly(string? domain)
    {
        if (string.IsNullOrWhiteSpace(domain)) return null;

        var value = domain.Trim();

        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0) value = value[(scheme + 3)..];

        var path = value.IndexOfAny(PathStarters);
        if (path >= 0) value = value[..path];

        // user:pass@host: credentials must never go out in any way
        var at = value.LastIndexOf('@');
        if (at >= 0) value = value[(at + 1)..];

        // Strip the port, but leave IPv6 ([::1]) alone: if there is more than one ':' do not touch it
        var colon = value.LastIndexOf(':');
        if (colon > 0 && value.IndexOf(':') == colon) value = value[..colon];

        value = value.Trim().TrimEnd('.');

        return value.Length == 0 ? null : value.ToLowerInvariant();
    }

    // ── events ──────────────────────────────────────────────────────────────

    internal sealed record EventsEnvelope
    {
        public required IReadOnlyList<EventDto> Events { get; init; }
    }

    internal sealed record EventDto
    {
        public required Guid ClientUuid { get; init; }
        public required string Type { get; init; }
        public required DateTimeOffset OccurredAt { get; init; }
        public IReadOnlyDictionary<string, object?>? Meta { get; init; }
    }

    internal static EventsEnvelope Events(IReadOnlyList<AgentEventRecord> events)
    {
        var list = new List<EventDto>(events.Count);
        foreach (var e in events)
        {
            list.Add(new EventDto
            {
                ClientUuid = e.ClientUuid,
                Type = e.Type,
                OccurredAt = e.OccurredAt,

                // No point sending an empty dictionary; if null the field is left out
                Meta = e.Meta is { Count: > 0 } ? e.Meta : null,
            });
        }

        return new EventsEnvelope { Events = list };
    }

    // ── heartbeat / enroll ──────────────────────────────────────────────────

    internal sealed record HeartbeatDto
    {
        public required string State { get; init; }
        public required int ActiveSecToday { get; init; }
        public int? QueueDepth { get; init; }
        public string? ConfigVersion { get; init; }
        public string? AgentVersion { get; init; }
        public IReadOnlyDictionary<string, string>? Capabilities { get; init; }
    }

    internal static HeartbeatDto Heartbeat(HeartbeatRequest request) => new()
    {
        State = StateToWire(request.State),

        // Careful: outside 0-86400 the server returns a 400. A 400 on a heartbeat deletes no
        // data, but then commands do not arrive either, so a revoke would not get through.
        // So a suspect value is clamped into the range here.
        ActiveSecToday = Math.Clamp(request.ActiveSecToday, 0, 86_400),

        QueueDepth = request.QueueDepth is { } d ? Math.Max(0, d) : null,
        ConfigVersion = request.ConfigVersion,
        AgentVersion = request.AgentVersion,
        Capabilities = request.Capabilities,
    };

    internal sealed record EnrollDto
    {
        public required string EnrollmentCode { get; init; }
        public required string Hostname { get; init; }
        public required string WindowsUsername { get; init; }
        public required string MachineGuid { get; init; }
        public string? OsVersion { get; init; }
        public string? AgentVersion { get; init; }
        public int? Monitors { get; init; }
    }

    internal static EnrollDto Enroll(EnrollRequest request) => new()
    {
        EnrollmentCode = request.EnrollmentCode,
        Hostname = request.Hostname,
        WindowsUsername = request.WindowsUsername,
        MachineGuid = request.MachineGuid,
        OsVersion = request.OsVersion,
        AgentVersion = request.AgentVersion,
        Monitors = request.Monitors,
    };

    /// <summary>
    /// Careful: these are exactly the fields of the server's `EnrollLoginDto`; if names or
    /// shapes change, both sides must change together.
    /// </summary>
    internal sealed record EnrollLoginDto
    {
        public required string Email { get; init; }
        public required string Password { get; init; }
        public string? Totp { get; init; }
        public required string Hostname { get; init; }
        public required string WindowsUsername { get; init; }
        public required string MachineGuid { get; init; }
        public string? OsVersion { get; init; }
        public string? AgentVersion { get; init; }
        public int? Monitors { get; init; }
    }

    internal static EnrollLoginDto EnrollLogin(EnrollLoginRequest request) => new()
    {
        // Careful: whitespace around the email is trimmed. People copy-pasting often bring
        // along a space, and the server would see an "unknown email" and answer 401, making
        // staff suspect their password.
        Email = request.Email.Trim(),
        // Careful: the password is **not trimmed**; a trailing space is part of the password
        Password = request.Password,
        Totp = string.IsNullOrWhiteSpace(request.Totp) ? null : request.Totp.Trim(),
        Hostname = request.Hostname,
        WindowsUsername = request.WindowsUsername,
        MachineGuid = request.MachineGuid,
        OsVersion = request.OsVersion,
        AgentVersion = request.AgentVersion,
        Monitors = request.Monitors,
    };

    // ── screenshot meta ─────────────────────────────────────────────────────

    /// <summary>
    /// The <c>meta</c> part of the multipart. Careful: it becomes a JSON <b>string</b>, not a
    /// JSON object; see <see cref="HttpSyncClient.SendScreenshotAsync"/>.
    /// </summary>
    internal sealed record ScreenshotMetaDto
    {
        public required Guid ClientUuid { get; init; }
        public required DateTimeOffset SlotStart { get; init; }
        public required DateTimeOffset CapturedAt { get; init; }
        public required int MonitorIndex { get; init; }
        public int? Width { get; init; }
        public int? Height { get; init; }
        public string? ActiveApp { get; init; }
        public string? ActiveTitle { get; init; }
    }

    internal static ScreenshotMetaDto ScreenshotMeta(ScreenshotRecord meta) => new()
    {
        ClientUuid = meta.ClientUuid,
        SlotStart = meta.SlotStart,
        CapturedAt = meta.CapturedAt,
        MonitorIndex = meta.MonitorIndex,
        Width = meta.Width,
        Height = meta.Height,

        // Careful: lengths are capped here just like app usage. The server's limits are
        // `activeApp` 260 and `activeTitle` 1000. Exceeding them gives a 400, and a 400 on a
        // screenshot means Permanent: the image would be **deleted** from the queue, when the
        // only fault was one long window title. The name comes from another program's
        // version resource, not from us.
        ActiveApp = Clamp(meta.ActiveApp, 260),
        ActiveTitle = Clamp(meta.ActiveTitle, 1000),
    };

    // ── what is read ────────────────────────────────────────────────────────

    /// <summary>
    /// The heartbeat response. Commands are snake_case strings on the wire and enums in C#,
    /// so it cannot be deserialized straight into <see cref="HeartbeatResponse"/>.
    /// An unknown command becomes null in <see cref="AgentCommands.Parse"/> and is dropped,
    /// so an old agent does not break when a future server sends a new command.
    /// </summary>
    internal sealed record HeartbeatResponseDto
    {
        public IReadOnlyList<string>? Commands { get; init; }
        public string? ConfigVersion { get; init; }

        /// <summary>
        /// Careful: <b>this field was missing, and that was a silent bug.</b> The server
        /// (<c>agent.controller.ts</c>) sends <c>progress</c> in every heartbeat response, but
        /// with no slot for it in the DTO, STJ quietly dropped it. So
        /// <see cref="HeartbeatResponse.Progress"/> was always null, and the tray showed
        /// <b>0 hours</b> for "this month" forever, even though the number on the server was
        /// right. The monthly milestone and pace features both rest on this.
        /// </summary>
        public ProgressDto? Progress { get; init; }
    }

    /// <summary>
    /// Careful: not deserialized straight into <see cref="EmployeeProgress"/>, even though it
    /// is the read side. That record has three <c>required</c> members, and in .NET 7+ STJ
    /// throws <c>JsonException</c> if a required member is missing from the JSON. If the
    /// server one day made a field optional, <b>the whole heartbeat response</b> (commands,
    /// revoke, configVersion included) could not be read; losing one progress field would
    /// cost us the tracking commands. So everything on the wire side is nullable.
    /// </summary>
    internal sealed record ProgressDto
    {
        public int? TodayActiveSec { get; init; }
        public int? MonthActiveSec { get; init; }
        public double? MonthlyTargetHours { get; init; }
        public int? PaceSec { get; init; }
        public int? DailyTargetSec { get; init; }
        public int? Week7ActiveSec { get; init; }
        public int? Week7TargetSec { get; init; }
        /// <summary>See <see cref="EmployeeProgress.Observed"/>.</summary>
        public bool? Observed { get; init; }
    }

    internal static HeartbeatResponse ToHeartbeatResponse(HeartbeatResponseDto dto)
    {
        var commands = new List<AgentCommand>();
        if (dto.Commands is not null)
        {
            foreach (var wire in dto.Commands)
            {
                if (AgentCommands.Parse(wire) is { } command) commands.Add(command);
            }
        }

        return new HeartbeatResponse
        {
            Commands = commands,
            ConfigVersion = dto.ConfigVersion ?? string.Empty,
            Progress = ToProgress(dto.Progress),
        };
    }

    /// <summary>
    /// When the device has no employee linked, the server sends <c>progress: null</c>; then
    /// null is returned, not an object filled with zeros.
    ///
    /// Careful: the whole thing is also discarded if <c>monthlyTargetHours ≤ 0</c>. With a zero
    /// target <see cref="AgentStatus.MonthlyProgress"/> returns 0, so a person who worked the
    /// whole month would see an empty progress bar all month.
    /// </summary>
    private static EmployeeProgress? ToProgress(ProgressDto? dto)
    {
        if (dto is null) return null;
        if (dto.MonthlyTargetHours is not { } target || target <= 0) return null;

        return new EmployeeProgress
        {
            TodayActiveSec = Math.Max(0, dto.TodayActiveSec ?? 0),
            MonthActiveSec = Math.Max(0, dto.MonthActiveSec ?? 0),
            MonthlyTargetHours = target,
            PaceSec = dto.PaceSec,

            // Careful: these are **not** wrapped in `Math.Max(0, …)`. null means "an old server
            // did not say", and 0 means "day off today". Flattening to zero would make the two
            // the same (see EmployeeProgress.DailyTargetSec).
            DailyTargetSec = dto.DailyTargetSec is { } d && d >= 0 ? d : null,
            Week7ActiveSec = dto.Week7ActiveSec is { } a && a >= 0 ? a : null,
            Week7TargetSec = dto.Week7TargetSec is { } w && w >= 0 ? w : null,

            // Careful: stays null if the server does not say, so behavior with an old server is
            // exactly as before (see EmployeeProgress.Observed).
            Observed = dto.Observed,
        };
    }
}
