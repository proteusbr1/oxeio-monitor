namespace oXeio.Core.Capture;

/// <summary>
/// How long to rest when the primary capture engine fails repeatedly.
///
/// <b>Why this is needed:</b> DXGI Desktop Duplication does not work at all in some
/// situations: an RDP session, an unsupported driver, or hitting the duplication limit while
/// sharing in Teams. On such a machine, building the whole COM chain every 5 minutes only to
/// fail is simply wasteful.
///
/// <b>Why it is not switched off for good:</b> most of the causes are temporary. Someone
/// leaves the RDP session, or the meeting ends, and then DXGI works again. If one failure
/// meant staying on GDI forever, that PC would produce black video for months and nobody
/// would know why.
///
/// So after several failures in a row, rest for a while, then look again once.
/// </summary>
public sealed class EngineFallbackPolicy(int failuresBeforeCooldown, TimeSpan cooldown)
{
    /// <summary>One failure proves nothing: it can happen on the lock screen alone.</summary>
    public const int DefaultFailuresBeforeCooldown = 3;

    /// <summary>
    /// 30 minutes, six slots. Long enough that the waste is negligible, short enough that DXGI
    /// is back the same working day after a meeting ends.
    /// </summary>
    public static readonly TimeSpan DefaultCooldown = TimeSpan.FromMinutes(30);

    public static EngineFallbackPolicy Default =>
        new(DefaultFailuresBeforeCooldown, DefaultCooldown);

    private readonly object _gate = new();
    private int _consecutiveFailures;
    private DateTimeOffset? _restingUntil;

    public int ConsecutiveFailures { get { lock (_gate) return _consecutiveFailures; } }

    /// <summary>Whether the primary engine should be tried now.</summary>
    public bool ShouldTryPrimary(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_restingUntil is null) return true;
            if (now < _restingUntil) return false;

            // The rest is over: one more round of chances. The counter is zeroed here, or the
            // very next single failure would hit the limit and the rest would be effectively
            // permanent.
            _restingUntil = null;
            _consecutiveFailures = 0;
            return true;
        }
    }

    public void RecordSuccess()
    {
        lock (_gate)
        {
            _consecutiveFailures = 0;
            _restingUntil = null;
        }
    }

    public void RecordFailure(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_restingUntil is not null) return; // not counted during the rest

            _consecutiveFailures++;
            if (_consecutiveFailures >= failuresBeforeCooldown)
                _restingUntil = now + cooldown;
        }
    }

    /// <summary>When the rest ends if one is under way: for showing in diagnostics.</summary>
    public DateTimeOffset? RestingUntil { get { lock (_gate) return _restingUntil; } }
}
