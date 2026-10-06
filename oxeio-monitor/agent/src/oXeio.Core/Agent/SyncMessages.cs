using oXeio.Core.Models;

namespace oXeio.Core.Agent;

// ── enroll ──────────────────────────────────────────────────────────────────

/// <summary><c>POST /agent/enroll</c>: the only call that needs no token.</summary>
public sealed record EnrollRequest
{
    /// <summary>A one-time code given by the admin, expires in 24 hours (H05).</summary>
    public required string EnrollmentCode { get; init; }

    public required string Hostname { get; init; }
    public required string WindowsUsername { get; init; }

    /// <summary>Hardware-based permanent id. Unique on the server: lets it recognize the same machine enrolling again.</summary>
    public required string MachineGuid { get; init; }

    public string? OsVersion { get; init; }
    public string? AgentVersion { get; init; }

    /// <summary>1 to 8. Outside that the server returns 400.</summary>
    public int? Monitors { get; init; }
}

/// <summary>
/// <c>POST /agent/enroll-login</c>: staff add their own PC using their own email and
/// password. No code needed.
///
/// <b>This is a <c>record</c>, so its generated <c>ToString</c> prints everything, password
/// included.</b> This object must <b>never</b> be logged; for exactly this reason
/// <c>EnrollmentClient</c> does not log <c>EnrollResponse</c> either.
/// </summary>
public sealed record EnrollLoginRequest
{
    public required string Email { get; init; }

    /// <summary>Goes over the wire only and is never stored; the token is what gets stored.</summary>
    public required string Password { get; init; }

    /// <summary>I06: the six-digit code if 2FA is on. Null on the first round.</summary>
    public string? Totp { get; init; }

    public required string Hostname { get; init; }
    public required string WindowsUsername { get; init; }
    public required string MachineGuid { get; init; }
    public string? OsVersion { get; init; }
    public string? AgentVersion { get; init; }
    public int? Monitors { get; init; }
}

/// <summary>
/// The reply can be of <b>two kinds</b>, and both are 200:
/// <list type="bullet">
/// <item><c>Status = "needs_totp"</c>: 2FA is on, a code is needed. The other fields are null.</item>
/// <item><c>Status = null</c>: success, with <c>DeviceToken</c> and everything else.</item>
/// </list>
///
/// So the fields are nullable. With <c>required</c> the "code needed" reply would fail at
/// deserialization, and the agent could never enroll on an account that has 2FA.
/// </summary>
public sealed record EnrollLoginResponse
{
    public string? Status { get; init; }
    public int? DeviceId { get; init; }
    public string? DeviceToken { get; init; }
    public EnrolledEmployee? Employee { get; init; }
    public string? ConfigVersion { get; init; }
    public AgentConfig? Config { get; init; }

    /// <summary>Cannot proceed without the six-digit 2FA code.</summary>
    public bool NeedsTotp => string.Equals(Status, "needs_totp", StringComparison.Ordinal);
}

public sealed record EnrollResponse
{
    public required int DeviceId { get; init; }

    /// <summary>
    /// Arrives only this once; the server stores only a sha256. If lost, the only way is to
    /// enroll again, which needs a new enrollment code. Write it to disk with DPAPI the moment
    /// it arrives, before anything else.
    /// </summary>
    public required string DeviceToken { get; init; }

    public required EnrolledEmployee Employee { get; init; }
    public required string ConfigVersion { get; init; }
    public required AgentConfig Config { get; init; }
}

public sealed record EnrolledEmployee(int Id, string EmpCode, string FullName);

// ── config ──────────────────────────────────────────────────────────────────

/// <summary><c>GET /agent/config</c>. <see cref="Version"/> is the first 16 characters of the config's sha256.</summary>
public sealed record ConfigResponse
{
    public required string Version { get; init; }
    public required AgentConfig Config { get; init; }
}

// ── heartbeat ───────────────────────────────────────────────────────────────

/// <summary><c>POST /agent/heartbeat</c>: every <see cref="AgentConfig.HeartbeatSec"/> seconds.</summary>
public sealed record HeartbeatRequest
{
    public required SegmentState State { get; init; }

    /// <summary>
    /// ACTIVE seconds so far on today's calendar in the work time zone. Outside 0 to 86400 the server returns 400.
    /// Resets to zero at midnight (the work zone's, not UTC's); see <see cref="oXeio.Core.Time.WorkTime"/>.
    /// </summary>
    public required int ActiveSecToday { get; init; }

    /// <summary><see cref="OutboxDepth.ForHeartbeat"/>. The dashboard sees a growing queue from here.</summary>
    public int? QueueDepth { get; init; }

    /// <summary>Its own config version. On a mismatch the server sends <see cref="AgentCommand.ReloadConfig"/>.</summary>
    public string? ConfigVersion { get; init; }

    /// <summary>
    /// The version the agent is running now.
    ///
    /// Sent once at enroll, but after an upgrade it would stay stale on the server. The server
    /// decides <b>from this number alone</b> whether to offer an update; if it were stale, an
    /// agent that had already updated would be offered the same update again and again
    /// ([G59](../../../../docs/08-Gap-Analysis.md)).
    /// </summary>
    public string? AgentVersion { get; init; }

    /// <summary>
    /// One state per part of the agent (<see cref="CapabilityReport"/>), e.g.
    /// <c>{ "browserDomain": "degraded" }</c>. A server older than the field
    /// ignores it.
    /// </summary>
    public IReadOnlyDictionary<string, string>? Capabilities { get; init; }
}

public sealed record HeartbeatResponse
{
    /// <summary>Unknown commands are dropped in <see cref="AgentCommands.Parse"/>, so they are not in this list.</summary>
    public required IReadOnlyList<AgentCommand> Commands { get; init; }

    public required string ConfigVersion { get; init; }

    /// <summary>
    /// The numbers for the tray's "x h / 208h" display: <b>they come from the server</b>.
    ///
    /// The agent cannot know this itself: it counts only its own running time, so after a
    /// reboot or update its count is zero. Staff would then see the month's work wiped, when
    /// the whole point of the feature is to build trust.
    ///
    /// <c>null</c> if no employee is attached to the device.
    /// </summary>
    public EmployeeProgress? Progress { get; init; }
}

/// <summary>The server's calculation; for several PCs they arrive summed (section 2.1(c)).</summary>
public sealed record EmployeeProgress
{
    public required int TodayActiveSec { get; init; }
    public required int MonthActiveSec { get; init; }
    public required double MonthlyTargetHours { get; init; }

    /// <summary>
    /// Pace: <c>credited - expected</c>, positive means ahead (07 section 2.1(b)).
    ///
    /// <b>Optional, and that is the point.</b> An exact figure needs working days counted,
    /// and working days mean weekly days off <b>and</b> the <c>holidays</c> table, which the
    /// agent knows nothing about. If the server sends the number, the tray shows it; if not,
    /// <c>MonthlyPace</c> makes a rough estimate and the window clearly labels it
    /// "approximate".
    ///
    /// A default of 0 <b>must not</b> be set here. 0 means "exactly on target", so if the
    /// server stayed silent everyone would look perfect forever.
    /// </summary>
    public int? PaceSec { get; init; }

    /// <summary>
    /// Today's target in seconds: monthly divided by that month's working days; 0 on a day off.
    ///
    /// <c>null</c> means "old server, did not say"; <b>0 means "day off today"</b>. Conflating
    /// the two would either show no bar at all on a day off, or nag with "8 hours left" on a
    /// day off.
    /// </summary>
    public int? DailyTargetSec { get; init; }

    /// <summary>Seconds counted over the last 7 days (including today).</summary>
    public int? Week7ActiveSec { get; init; }

    /// <summary>Working days in those 7 days times the daily target. A rolling 7 days, not "this week".</summary>
    public int? Week7TargetSec { get; init; }

    /// <summary>
    /// <b>G111</b>: whether even one <b>finished</b> working day of this person has been
    /// observed yet.
    ///
    /// If none has been observed, the server's <see cref="PaceSec"/> is exactly <c>0</c>, and 0
    /// means "exactly on target", so on a new employee's first day the window would say
    /// "0:00 ahead". The number is not false; the sentence is.
    ///
    /// In this state the code also <b>must not fall back to the rough estimate</b>
    /// (<see cref="oXeio.Agent.Ui.MonthlyPace"/>): that counts from the 1st of the month, so it
    /// would show a shortfall for a day on which the measuring instrument was not even
    /// installed. The answer is not a number but <b>"nothing to report yet"</b>.
    ///
    /// <c>null</c> = an old server did not say, so behave as before (treated as "observed").
    /// Otherwise, before the server update every tray would say "not observed yet" even though
    /// everyone's numbers were working fine.
    /// </summary>
    public bool? Observed { get; init; }
}

// ── ingest ──────────────────────────────────────────────────────────────────

/// <summary>
/// The reply for all three: segments / app-usage / events.
///
/// <see cref="Duplicates"/> is <b>not</b> a failure. A duplicate means an earlier attempt did
/// actually arrive and we only missed the reply, so the data is on the server.
/// Both must be acked as success (section 2.1(d)). Otherwise that batch would be retried
/// forever and the queue would never empty.
/// </summary>
public sealed record IngestAck
{
    public required int Accepted { get; init; }
    public required int Duplicates { get; init; }

    /// <summary>Number of records the server split at midnight (G43). Nothing for the agent to do.</summary>
    public required int Split { get; init; }
}

public sealed record ScreenshotAck
{
    public required bool Accepted { get; init; }

    /// <summary>The same <c>(device, slotStart, monitorIndex)</c> already existed. Also a success.</summary>
    public required bool Duplicate { get; init; }

    /// <summary>Where the file landed on the server. For the log only.</summary>
    public string? Path { get; init; }
}

// ── update ──────────────────────────────────────────────────────────────────

/// <summary>
/// <c>GET /agent/update?current=X</c>. A 204 means no offer: then
/// <see cref="SyncResult{T}.Value"/> is null but
/// <see cref="SyncResult{T}.Outcome"/> is <see cref="SyncOutcome.Success"/>.
/// </summary>
public sealed record UpdateOffer
{
    public required string Version { get; init; }

    /// <summary>The hash must be checked before running the MSI. This is mandatory.</summary>
    public required string Sha256 { get; init; }

    /// <summary>A server-relative path, e.g. <c>/api/v1/agent/update/download?version=1.2.0</c>.</summary>
    public required string Url { get; init; }

    public required bool Mandatory { get; init; }

    /// <summary>
    /// Base64 DER ECDSA signature of the MSI's SHA-256, made with the owner's
    /// key (<see cref="UpdateSignature"/>). <c>null</c> when the version was
    /// published unsigned, or the server is older than the field.
    /// </summary>
    public string? Signature { get; init; }
}

/// <summary><c>GET /agent/update/download</c> after it finishes: the MSI has been saved to disk.</summary>
public sealed record UpdateDownload
{
    public required string SavedPath { get; init; }
    public required long Bytes { get; init; }

    /// <summary>The real hash of the downloaded file. If it does not match <see cref="UpdateOffer.Sha256"/>, delete the file.</summary>
    public required string Sha256 { get; init; }
}
