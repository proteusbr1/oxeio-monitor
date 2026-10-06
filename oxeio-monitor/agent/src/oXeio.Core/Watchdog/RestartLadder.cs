namespace oXeio.Core.Watchdog;

/// <summary>
/// How fast to restart, how many times, and when to stop: pure settings.
/// </summary>
public sealed record RestartPolicy
{
    public RestartPolicy(
        TimeSpan baseDelay,
        double multiplier,
        TimeSpan maxDelay,
        int giveUpAfter,
        TimeSpan coolOff,
        TimeSpan stabilityWindow)
    {
        if (baseDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(baseDelay));
        if (multiplier < 1) throw new ArgumentOutOfRangeException(nameof(multiplier));
        if (maxDelay < baseDelay) throw new ArgumentOutOfRangeException(nameof(maxDelay));
        if (giveUpAfter < 1) throw new ArgumentOutOfRangeException(nameof(giveUpAfter));

        // If the cool-off were shorter than the biggest step, there would be no such thing as
        // "giving up": the ladder would end and attempts would start again more often than before.
        if (coolOff < maxDelay) throw new ArgumentOutOfRangeException(nameof(coolOff));
        if (stabilityWindow <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(stabilityWindow));

        BaseDelay = baseDelay;
        Multiplier = multiplier;
        MaxDelay = maxDelay;
        GiveUpAfter = giveUpAfter;
        CoolOff = coolOff;
        StabilityWindow = stabilityWindow;
    }

    /// <summary>The wait after the first failed launch.</summary>
    public TimeSpan BaseDelay { get; }

    public double Multiplier { get; }

    /// <summary>The ceiling.</summary>
    public TimeSpan MaxDelay { get; }

    /// <summary>After launching this many times the agent still did not survive: no more hammering after that.</summary>
    public int GiveUpAfter { get; }

    /// <summary>After giving up, how often to try just once.</summary>
    public TimeSpan CoolOff { get; }

    /// <summary>After this long of continuous health the ladder starts again from zero.</summary>
    public TimeSpan StabilityWindow { get; }

    /// <summary>
    /// The steps: 30 s → 1.5 min → 4.5 min → 13.5 min → 15 min (ceiling), giving up after
    /// five attempts, then one attempt every 6 hours, and after 10 minutes of continuous
    /// health everything is forgotten and it starts afresh.
    ///
    /// <b>How the numbers came about:</b> the watchdog itself looks every 30 seconds, so there
    /// is no point writing a smaller step. Five steps total about 35 minutes: an agent that
    /// crashes at startup gets five honest chances, and if it still fails the problem is not
    /// one a restart will fix. 6 hours means 4 times a day: the CPU never notices it, yet
    /// temporary problems such as AV quarantine or a locked config file clear up by
    /// themselves, and nobody has to visit 15 PCs.
    /// </summary>
    public static RestartPolicy Default { get; } = new(
        baseDelay: TimeSpan.FromSeconds(30),
        multiplier: 3,
        maxDelay: TimeSpan.FromMinutes(15),
        giveUpAfter: 5,
        coolOff: TimeSpan.FromHours(6),
        stabilityWindow: TimeSpan.FromMinutes(10));
}

/// <summary>
/// <b>The most important behavior of this module: preventing a restart storm.</b>
///
/// A naive watchdog says: "no process? start it." If the agent crashes right at startup
/// (wrong config, AV quarantine, a corrupt queue.db), that loop creates a process twice a
/// second, on 15 PCs at once, all night, and the first thing anyone notices in the morning
/// is the noise of the fans. So there are three separate safeguards here:
///
/// <list type="number">
/// <item><b>Every launch is assumed to have failed in advance</b> (<see cref="RecordLaunch"/>
/// raises the count immediately). With the optimism of "start it and see if it survives", a
/// process that dies 10 ms after creation would never be counted as a failure.</item>
///
/// <item><b>Only continuous health resets the ladder</b> (<see cref="Observe"/>), not merely
/// "it started once". In a crash loop the process <i>does</i> start again and again.</item>
///
/// <item><b>Giving up does not mean stopping for good, it means cooling off.</b> If it stopped
/// for good, a temporary problem (such as the exe being locked during an AV update) would need
/// a person to go and fix each of the 15 PCs, and until then nobody's time would be counted.
/// So the twice-a-second loop is brought down to four times a day, not switched off.</item>
/// </list>
///
/// This class has no clock: the caller supplies <c>now</c>. The caller must pass
/// <see cref="oXeio.Core.Time.MonotonicClock"/>, not <c>DateTimeOffset.Now</c>: if the wall
/// clock were set back, the cool-off would never end.
/// </summary>
public sealed class RestartLadder
{
    private readonly RestartPolicy _policy;

    private int _failures;
    private DateTimeOffset? _lastLaunchAt;
    private DateTimeOffset? _healthySince;
    private bool _alarmRaised;

    public RestartLadder(RestartPolicy? policy = null) => _policy = policy ?? RestartPolicy.Default;

    public RestartPolicy Policy => _policy;

    /// <summary>How many times it has been launched so far without being kept running.</summary>
    public int Failures => _failures;

    /// <summary>The ladder is spent: now only one attempt per cool-off interval.</summary>
    public bool IsExhausted => _failures >= _policy.GiveUpAfter;

    /// <summary>Whether the visible signal (alarm file/log) has been given, once only.</summary>
    public bool AlarmRaised => _alarmRaised;

    public DateTimeOffset? LastLaunchAt => _lastLaunchAt;

    /// <summary>
    /// The wait after the <paramref name="failures"/>-th failure.
    /// <c>Math.Pow</c> gives infinity after a few thousand steps and <c>TimeSpan.FromSeconds(infinity)</c>
    /// throws, so the ceiling is applied on the double <b>before</b> building the TimeSpan.
    /// Throwing here would kill the watchdog itself, leaving a machine with no guard.
    /// </summary>
    public TimeSpan DelayAfter(int failures)
    {
        if (failures <= 0) return TimeSpan.Zero;

        var seconds = _policy.BaseDelay.TotalSeconds * Math.Pow(_policy.Multiplier, failures - 1);

        return double.IsNaN(seconds) || seconds >= _policy.MaxDelay.TotalSeconds
            ? _policy.MaxDelay
            : TimeSpan.FromSeconds(seconds);
    }

    /// <summary>How much remains before the next attempt. Zero means it can be tried now.</summary>
    public TimeSpan TimeUntilNextLaunch(DateTimeOffset now)
    {
        // First time: coming back within 30 seconds of a kill from Task Manager is our
        // acceptance condition (H01), so there is no delay here.
        if (_failures == 0 || _lastLaunchAt is not { } last) return TimeSpan.Zero;

        var wait = IsExhausted ? _policy.CoolOff : DelayAfter(_failures);

        var elapsed = now - last;

        // If a caller wrongly passed the wall clock, or someone set the clock back, elapsed
        // would be negative, and the watchdog would silently wait forever. Clamping to zero
        // makes the worst result one extra interval, not the guard switching off.
        if (elapsed < TimeSpan.Zero) elapsed = TimeSpan.Zero;

        var left = wait - elapsed;
        return left > TimeSpan.Zero ? left : TimeSpan.Zero;
    }

    public bool MayLaunch(DateTimeOffset now) => TimeUntilNextLaunch(now) <= TimeSpan.Zero;

    /// <summary>
    /// An attempt to start the agent was just made.
    ///
    /// The caller must call this <b>before launching</b>. If <c>Process.Start</c> throws (exe
    /// missing, blocked by AV) and this were called afterwards, the count would never rise and
    /// the loop would retry every 30 seconds forever: exactly the storm it is meant to prevent.
    /// </summary>
    public void RecordLaunch(DateTimeOffset now)
    {
        if (_failures < int.MaxValue) _failures++;
        _lastLaunchAt = now;
        _healthySince = null;
    }

    /// <summary>
    /// Told on every tick whether the agent is healthy. After continuous
    /// <see cref="RestartPolicy.StabilityWindow"/> of health the ladder resets.
    /// </summary>
    public void Observe(bool healthy, DateTimeOffset now)
    {
        if (!healthy)
        {
            _healthySince = null;
            return;
        }

        if (_healthySince is not { } since || now < since)
        {
            // now < since means the clock went back: if the anchor were not moved forward,
            // this agent would never be considered "stable" again.
            _healthySince = now;
            since = now;
        }

        if (now - since >= _policy.StabilityWindow) Reset();
    }

    /// <summary>The alarm has been given: it will not be written again every 30 seconds.</summary>
    public void MarkAlarmRaised() => _alarmRaised = true;

    public void Reset()
    {
        _failures = 0;
        _lastLaunchAt = null;
        _healthySince = null;
        _alarmRaised = false;
    }
}
