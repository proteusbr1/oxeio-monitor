namespace oXeio.Core.Watchdog;

/// <summary>
/// What the agent process holds right now: measured by <c>ResourceProbe</c> in the agent (Windows
/// only), judged here (pure).
/// </summary>
public sealed record ResourceSample
{
    /// <summary>Kernel handles (<c>GetProcessHandleCount</c>).</summary>
    public required long HandleCount { get; init; }

    /// <summary>Committed private memory (<c>PROCESS_MEMORY_COUNTERS_EX.PrivateUsage</c>).</summary>
    public required long PrivateBytes { get; init; }

    /// <summary><c>GetGuiResources(GR_GDIOBJECTS)</c>. Windows caps it at 10,000 by default.</summary>
    public required int GdiObjects { get; init; }

    /// <summary><c>GetGuiResources(GR_USEROBJECTS)</c>.</summary>
    public required int UserObjects { get; init; }

    /// <summary>
    /// Which of <see cref="ResourceCeiling.WatchedModules"/> are loaded in the process, lower-case.
    /// Empty is the normal case.
    /// </summary>
    public IReadOnlyList<string> InjectedModules { get; init; } = [];
}

/// <summary>What the agent should do about its own resource use, on this check.</summary>
public enum CeilingAction
{
    /// <summary>Under the ceiling, or nothing may be done now (shutdown under way).</summary>
    None,

    /// <summary>Over the ceiling, but wait: for a quiet moment, or for the process to age.</summary>
    Wait,

    /// <summary>Over the ceiling, and a restart must not happen: only log it and report it.</summary>
    ReportOnly,

    /// <summary>Restart cleanly now.</summary>
    Restart,
}

/// <summary>Why. An enum, not a string, for the same reason as <see cref="WatchdogReason"/>.</summary>
public enum CeilingReason
{
    WithinLimits,
    ShuttingDown,

    /// <summary>The process is younger than <see cref="ResourceCeiling.MinUptime"/>.</summary>
    TooYoung,

    /// <summary>A ceiling restart already happened less than <see cref="ResourceCeiling.MinGapBetweenRestarts"/> ago.</summary>
    BackedOff,

    /// <summary>No watchdog is running: exiting would leave the PC untracked until the next logon.</summary>
    NoWatchdog,

    WaitingForQuiet,
    QuietMoment,

    /// <summary>Over <see cref="ResourceCeiling.HardFactor"/> times the ceiling: no more waiting.</summary>
    HardCeiling,

    /// <summary>Over the ceiling for longer than <see cref="ResourceCeiling.MaxWaitForQuiet"/>.</summary>
    OverTooLong,
}

/// <summary>Everything one check needs. All gathered by the caller; nothing is read here.</summary>
public sealed record CeilingInput
{
    public required ResourceSample Sample { get; init; }

    /// <summary>The agent's <see cref="Time.MonotonicClock"/> now.</summary>
    public required DateTimeOffset Now { get; init; }

    /// <summary>
    /// Since when it has been over, on the same monotonic clock: what the previous
    /// <see cref="CeilingDecision.OverSince"/> returned. <c>null</c> on the first check.
    /// </summary>
    public DateTimeOffset? OverSince { get; init; }

    /// <summary>How long this process has been running.</summary>
    public required TimeSpan Uptime { get; init; }

    /// <summary>
    /// Nobody is losing anything right now: the session is idle or locked, or nothing is being
    /// tracked (not signed in, revoked).
    /// </summary>
    public required bool Quiet { get; init; }

    /// <summary>The agent is already shutting down, or Windows is (logoff/shutdown seen).</summary>
    public required bool ShuttingDown { get; init; }

    /// <summary>
    /// A watchdog holds <c>watchdog.lock</c>. Careful: "could not tell" must be passed as
    /// <c>false</c>, see <see cref="CeilingReason.NoWatchdog"/>.
    /// </summary>
    public required bool WatchdogPresent { get; init; }

    /// <summary>When the last ceiling restart was requested (wall clock, read from disk).</summary>
    public DateTimeOffset? LastRestartUtc { get; init; }

    public required DateTimeOffset NowUtc { get; init; }
}

public sealed record CeilingDecision
{
    public required CeilingAction Action { get; init; }
    public required CeilingReason Reason { get; init; }

    /// <summary>To pass back as <see cref="CeilingInput.OverSince"/> next time.</summary>
    public DateTimeOffset? OverSince { get; init; }
}

/// <summary>
/// <b>The agent's own resource ceiling: when it should restart itself, cleanly.</b>
///
/// Why it exists: an NVIDIA overlay injects <c>nvspcap64.dll</c> into processes that capture the
/// screen, and in one agent it leaked ~217,000 handles and 7 GB of private memory over twelve days.
/// The trigger is being fixed in the capture code, but the next third-party DLL will find another
/// one; this is the defence in depth. A clean restart frees everything the process holds, and the
/// watchdog brings a fresh one back within ~30 seconds.
///
/// <b>Why the agent decides, not the watchdog:</b> the agent knows whether the user is in the
/// middle of work (state, sign-in, shutdown under way) and can leave through the normal graceful
/// path: open segment closed, <c>agent_stop</c> sent with a reason. The watchdog only knows how to
/// <c>Kill</c>, which loses the open segment and looks like tampering to the server.
///
/// <b>The asymmetry here</b>, like the watchdog's: a restart while someone is working costs ~30
/// seconds of their counted time; a restart loop costs their whole day. So every doubt goes to
/// "do not restart": no watchdog (or cannot tell) → no; restarted recently → no; too young → wait.
/// </summary>
public static class ResourceCeiling
{
    /// <summary>
    /// A healthy agent holds ~600-1,500 handles. 20,000 is more than ten times that, so it is
    /// never reached by honest work, yet low enough to act weeks before Windows' per-process limit
    /// or the user noticing the PC slow down (the field case passed it in about a day).
    /// </summary>
    public const long MaxHandles = 20_000;

    /// <summary>
    /// 1.5 GiB. A healthy agent's private memory is ~80-200 MB; the field leak reached 7 GB.
    /// Careful: on a 4 GB office PC 1.5 GB is already felt by the user, so it is not set higher.
    /// </summary>
    public const long MaxPrivateBytes = 1_610_612_736;

    /// <summary>Above this many times either ceiling it restarts at once, without waiting for quiet.</summary>
    public const int HardFactor = 2;

    /// <summary>How often the check runs. Measuring is a handful of cheap syscalls; this is about the log.</summary>
    public static TimeSpan CheckEvery => TimeSpan.FromMinutes(1);

    /// <summary>
    /// How long it waits for an idle or locked moment before restarting anyway. An hour of
    /// continuous typing is rare; a leak that grew to the ceiling in a day does not double in an hour.
    /// </summary>
    public static TimeSpan MaxWaitForQuiet => TimeSpan.FromHours(1);

    /// <summary>
    /// A process younger than this is not restarted. Careful: it must be longer than the watchdog
    /// ladder's <see cref="RestartPolicy.StabilityWindow"/> (10 min), so a planned restart always
    /// comes from an agent the watchdog already regards as stable.
    /// </summary>
    public static TimeSpan MinUptime => TimeSpan.FromMinutes(15);

    /// <summary>
    /// <b>The loop guard.</b> At most one ceiling restart per this interval, persisted on disk so a
    /// fresh process sees it. If a fresh process is over the ceiling again within six hours, the
    /// restart did not help (the cause is outside us), so the next one only reports. Four a day at
    /// most, which nobody notices.
    /// </summary>
    public static TimeSpan MinGapBetweenRestarts => TimeSpan.FromHours(6);

    /// <summary>
    /// Third-party DLLs known to leak inside the agent. Bare file names, lower-case; the server
    /// accepts only <c>^[A-Za-z0-9][A-Za-z0-9._-]*$</c> and at most 8 of them.
    ///
    /// <c>nvspcap64.dll</c>: NVIDIA's ShadowPlay/Instant Replay capture hook, injected into any
    /// process that uses Desktop Duplication.
    /// </summary>
    public static IReadOnlyList<string> WatchedModules { get; } = ["nvspcap64.dll"];

    public static bool IsOver(ResourceSample sample)
    {
        ArgumentNullException.ThrowIfNull(sample);
        return sample.HandleCount > MaxHandles || sample.PrivateBytes > MaxPrivateBytes;
    }

    public static bool IsHard(ResourceSample sample)
    {
        ArgumentNullException.ThrowIfNull(sample);
        return sample.HandleCount > MaxHandles * HardFactor
               || sample.PrivateBytes > MaxPrivateBytes * HardFactor;
    }

    public static CeilingDecision Decide(CeilingInput input)
    {
        ArgumentNullException.ThrowIfNull(input);

        if (!IsOver(input.Sample))
            return new() { Action = CeilingAction.None, Reason = CeilingReason.WithinLimits };

        // Careful: a monotonic anchor "in the future" cannot happen within one process, but if a
        // caller ever passed a value from another clock, trusting it would keep "over for an hour"
        // from ever coming true. Restarting the count is the harmless direction.
        var overSince = input.OverSince is { } since && since <= input.Now ? since : input.Now;

        CeilingDecision Make(CeilingAction action, CeilingReason reason) =>
            new() { Action = action, Reason = reason, OverSince = overSince };

        // Already leaving: a second exit request in the middle of DisposeAsync would at best do
        // nothing, at worst cut the goodbye drain short.
        if (input.ShuttingDown) return Make(CeilingAction.None, CeilingReason.ShuttingDown);

        if (input.Uptime < MinUptime) return Make(CeilingAction.Wait, CeilingReason.TooYoung);

        // Careful: a timestamp in the future means the clock was set back. It is treated as "no
        // recent restart": the worst case is one extra restart, after which the new stamp is in
        // the (new) past and the guard works again. The opposite choice could block restarts for
        // as long as the clock was moved back, a year if someone typed the wrong year.
        if (input.LastRestartUtc is { } last
            && input.NowUtc >= last
            && input.NowUtc - last < MinGapBetweenRestarts)
        {
            return Make(CeilingAction.ReportOnly, CeilingReason.BackedOff);
        }

        // Careful: without a watchdog, "restart" means "exit": the PC would go untracked until the
        // next logon. A leaking agent that keeps counting is far better than no agent.
        if (!input.WatchdogPresent) return Make(CeilingAction.ReportOnly, CeilingReason.NoWatchdog);

        if (IsHard(input.Sample)) return Make(CeilingAction.Restart, CeilingReason.HardCeiling);

        if (input.Now - overSince >= MaxWaitForQuiet)
            return Make(CeilingAction.Restart, CeilingReason.OverTooLong);

        return input.Quiet
            ? Make(CeilingAction.Restart, CeilingReason.QuietMoment)
            : Make(CeilingAction.Wait, CeilingReason.WaitingForQuiet);
    }
}
