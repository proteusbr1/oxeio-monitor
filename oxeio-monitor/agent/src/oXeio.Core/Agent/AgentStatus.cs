using oXeio.Core.Models;

namespace oXeio.Core.Agent;

/// <summary>
/// How sync is going. The tray icon color is decided from this (J07).
/// </summary>
public enum SyncHealth
{
    /// <summary>Everything is arriving. Normal icon.</summary>
    Ok,

    /// <summary>A few attempts failed, but not yet worrying. Normal icon, hint in the tooltip.</summary>
    Degraded,

    /// <summary>
    /// Failing repeatedly. The icon is <b>red</b>, and the tooltip must say outright that data
    /// is not lost and is being kept locally, or staff will assume their hours are being deleted.
    /// </summary>
    Failing,

    /// <summary>Device revoked (H06). Tracking is stopped and the icon must show it.</summary>
    Revoked,
}

/// <summary>
/// Everything the tray icon shows, and nothing more.
///
/// There are no buttons and no inputs. Anything staff could press would become the first step
/// of an approval workflow (ADR-011d), and this system has none. The tray only <b>shows</b>:
/// an always-visible icon is what proves the installation is not covert.
/// </summary>
public sealed record AgentStatus
{
    public required SegmentState State { get; init; }

    /// <summary>
    /// State of the update: the tray's "Install update" item rests on this.
    ///
    /// <c>required</c>, not optional: if it were not filled in, the item would **never** appear
    /// and nobody would notice. A new version would be downloaded, verified and left on disk
    /// with no way for staff to install it.
    /// </summary>
    public required UpdateStatus Update { get; init; }

    /// <summary>Today's ACTIVE time on the work time zone's calendar.</summary>
    public required TimeSpan ActiveToday { get; init; }

    /// <summary>
    /// <b>When</b> this snapshot was taken (real clock).
    ///
    /// <see cref="ActiveToday"/> is correct up to that moment, including the open segment.
    /// But snapshots are taken on events (heartbeat, segment, status change), not every
    /// second. So the window counts the remainder from this time itself, and the clock ticks
    /// every second (<see cref="LiveDuration"/>).
    ///
    /// <c>null</c> means "unknown": <see cref="LiveDuration"/> then adds not even one second on
    /// its own. The field is optional on purpose: making it <c>required</c> would break old
    /// preview/test constructions, and a default <c>default(DateTimeOffset)</c> (year 0001)
    /// would make the "elapsed time" about two thousand years, hitting the cap every time and
    /// adding a wrong amount.
    /// </summary>
    public DateTimeOffset? CountedAt { get; init; }

    /// <summary>This month's ACTIVE time on the work time zone's calendar. It is compared with the monthly 208 hours.</summary>
    public required TimeSpan ActiveThisMonth { get; init; }

    /// <summary>
    /// Whether <see cref="ActiveThisMonth"/> really came from the server.
    ///
    /// <b>Without this flag, "not known yet" and "zero hours" would look the same.</b>
    /// The agent keeps no month total itself (everything resets on reboot), so until the first
    /// heartbeat arrives this holds 0. Showing that 0 as true would make staff see
    /// "0 / 208 hours · 208 hours behind" at every login, as if the month's work were wiped.
    /// A feature whose whole purpose is building trust would break it every morning.
    ///
    /// When <c>false</c>, the display should say "calculating", not zero.
    /// </summary>
    public bool MonthlyKnown { get; init; }

    /// <summary><see cref="AgentConfig.MonthlyTargetHours"/>, usually 208.</summary>
    public required double MonthlyTargetHours { get; init; }

    /// <summary>See <see cref="EmployeeProgress.NoTarget"/>: show hours only, no targets.</summary>
    public bool NoTarget { get; init; }

    /// <summary>
    /// Pace: how far ahead or behind where the month's progress should be on this day.
    /// Positive means ahead (<see cref="EmployeeProgress.PaceSec"/>).
    ///
    /// <c>null</c> means "the server did not say", not "zero". Zero means exactly on target;
    /// conflating the two would show staff a perfect position every moment the server is silent.
    /// When null, the display makes its own rough estimate and labels it "approximate".
    ///
    /// The name is not <c>MonthlyPace</c>: a class called <c>Ui.MonthlyPace</c> exists, and when
    /// a property and a type share a name it becomes unclear at the call site which is meant
    /// (see the comment on <see cref="Health"/>).
    /// </summary>
    public TimeSpan? Pace { get; init; }

    /// <summary>
    /// <b>G111</b>: the server says not one <b>finished</b> working day of this person has
    /// been observed yet.
    ///
    /// <see cref="Pace"/> being <c>null</c> could not express this, which is the whole reason
    /// for this field. <c>null</c> means "the server did not say", and the window then
    /// <b>falls back to its own rough estimate</b>, which counts from the 1st of the month and
    /// would show exactly those unobserved days as a shortfall. Fixing one false reassurance
    /// would have caused the opposite: a false accusation.
    ///
    /// Defaults to <c>true</c>, so behavior is exactly as before with an old server or before
    /// the first heartbeat.
    /// </summary>
    public bool PaceObserved { get; init; } = true;

    /// <summary>Number of queue items not yet uploaded.</summary>
    public required int QueueDepth { get; init; }

    /// <summary>The last time the server actually accepted something. Null if never.</summary>
    public DateTimeOffset? LastSyncAt { get; init; }

    /// <summary>
    /// The property is named <c>Health</c>, not <c>SyncHealth</c>: when a property and its type
    /// share a name (the "Color Color" problem), writing <c>SyncHealth.Ok</c> in a static
    /// context becomes ambiguous.
    /// </summary>
    public required SyncHealth Health { get; init; }

    /// <summary>The tooltip's second line, e.g. "Can't reach server, data saved locally".</summary>
    public string? HealthDetail { get; init; }

    /// <summary>Whether <see cref="AgentCommand.PauseTracking"/> is in effect.</summary>
    public required bool Paused { get; init; }

    /// <summary>
    /// Whether this device is bound to an employee.
    ///
    /// <b><c>required</c> on purpose, no default.</b> A default of <c>true</c> would let any
    /// place that forgot to set it silently say "signed in", reopening the way back for the
    /// very bug being fixed. A default of <c>false</c> has the opposite danger: forgetting one
    /// place would make a signed-in machine show "Sign in to start".
    ///
    /// With <c>required</c> the compiler itself checks that every caller sets it, which is
    /// exactly the mistake that happened six times in this project.
    /// </summary>
    public required bool Enrolled { get; init; }

    /// <summary>
    /// Today's target. <c>null</c> = the server did not say; <c>Zero</c> = a day off.
    /// The two are not the same: showing a bar on a day off makes no sense, and showing nothing
    /// is better than showing a wrong bar when it is unknown.
    /// </summary>
    public TimeSpan? DailyTarget { get; init; }

    /// <summary>Time counted over the last 7 days (including today).</summary>
    public TimeSpan? ActiveLast7 { get; init; }

    /// <summary>Working days in those 7 days times the daily target.</summary>
    public TimeSpan? Last7Target { get; init; }

    /// <summary>
    /// <b>What percentage of the time</b> keyboard/mouse was active in the recent 5-minute
    /// slots (B13), ordered oldest to newest.
    ///
    /// This is <b>not a count of presses</b>, and never will be. Counting needs a low-level
    /// hook, which is keylogging: forbidden in <c>04-Features § L</c>, and the proposal was
    /// explicitly rejected in <c>G46</c>. Each second the agent only sees "how long since the
    /// last input", so it cannot know what was pressed or how often.
    ///
    /// An idle slot is 0: saying "no hands moved" is true, leaving a gap is not.
    /// </summary>
    public IReadOnlyList<int> RecentBusy { get; init; } = [];

    /// <summary>Path of the thumbnail of the last picture taken. Null if none was taken.</summary>
    public string? LatestShotThumb { get; init; }

    /// <summary>When that picture was taken.</summary>
    public DateTimeOffset? LatestShotAt { get; init; }

    /// <summary>How many screens' pictures were taken at that moment: "1 of 1" vs "2".</summary>
    public int LatestShotMonitors { get; init; }

    /// <summary>
    /// 0 = nothing done, 1 = target met. It is <b>not</b> clamped above: showing someone who
    /// worked 220 hours as 100% would hide their extra work. The caller applies
    /// <c>Math.Min(1, …)</c> itself when drawing the progress bar.
    /// </summary>
    public double MonthlyProgress =>
        MonthlyTargetHours <= 0 ? 0 : Math.Max(0, ActiveThisMonth.TotalHours / MonthlyTargetHours);

    /// <summary>How much is left to reach the target. <see cref="TimeSpan.Zero"/> once met.</summary>
    public TimeSpan MonthlyRemaining
    {
        get
        {
            var left = TimeSpan.FromHours(MonthlyTargetHours) - ActiveThisMonth;
            return left > TimeSpan.Zero ? left : TimeSpan.Zero;
        }
    }

    /// <summary>
    /// Today's progress: <c>null</c> if the target is unknown or on a day off.
    /// Like <see cref="MonthlyProgress"/> it is not clamped above; the caller trims it when
    /// drawing the bar.
    /// </summary>
    public double? DailyProgress =>
        DailyTarget is { } t && t > TimeSpan.Zero
            ? Math.Max(0, ActiveToday.TotalSeconds / t.TotalSeconds)
            : null;

    /// <summary>Progress over the last 7 days. <c>null</c> if either the target or the work is unknown.</summary>
    public double? Last7Progress =>
        Last7Target is { } t && t > TimeSpan.Zero && ActiveLast7 is { } worked
            ? Math.Max(0, worked.TotalSeconds / t.TotalSeconds)
            : null;

    /// <summary>What the tray shows after startup, before the first tick arrives.</summary>
    public static AgentStatus Starting => new()
    {
        State = SegmentState.Idle,
        // At startup nothing is known about updates: `Idle` means "I know nothing"
        Update = UpdateStatus.Idle,
        ActiveToday = TimeSpan.Zero,
        ActiveThisMonth = TimeSpan.Zero,
        MonthlyTargetHours = 208,
        QueueDepth = 0,
        Health = SyncHealth.Ok,
        Paused = false,

        // false: at startup the credentials have not been read yet, so there is no basis for
        // assuming "signed in". The real value is set on the first tick; the error lasts one
        // second and is on the safe side.
        Enrolled = false,
    };
}

/// <summary>
/// Where the status is shown: the tray icon in production, a list in tests.
///
/// Careful: <see cref="Publish"/> is called from the tracking and sync threads, not the UI
/// thread. In WinForms the implementation itself must marshal before touching the UI
/// (<c>SynchronizationContext</c> / <c>Control.BeginInvoke</c>). Forgetting does not crash at
/// once; it crashes a couple of weeks later, when nobody is watching.
///
/// Careful: <see cref="Publish"/> must never block or throw. A tray fault must not stop
/// hours from being counted.
/// </summary>
public interface IAgentStatusSink
{
    void Publish(AgentStatus status);
}
