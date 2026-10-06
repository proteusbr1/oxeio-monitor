using System.Runtime.Versioning;

using oXeio.Core.Capture;

namespace oXeio.Agent.Platform.Capture;

/// <summary>
/// DXGI first, GDI if that fails ([ADR-012c](../../../../docs/history/05-Options-Decisions.md)).
///
/// The two engines do not know about each other; the decision of which to use when is here, and
/// <b>how long before trying again</b> is in <see cref="EngineFallbackPolicy"/> (pure logic, unit
/// tested).
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class FallbackCapturer(
    IScreenCapturer primary,
    IScreenCapturer fallback,
    EngineFallbackPolicy? policy = null,
    Func<DateTimeOffset>? clock = null) : IScreenCapturer
{
    private readonly EngineFallbackPolicy _policy = policy ?? EngineFallbackPolicy.Default;
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    public string Name => $"{primary.Name}→{fallback.Name}";

    /// <summary>When the pause ends, if one is in effect: to show in the diagnostic tool.</summary>
    public DateTimeOffset? PrimaryRestingUntil => _policy.RestingUntil;

    public CapturedFrame? Capture(MonitorInfo monitor)
    {
        var now = _clock();

        if (_policy.ShouldTryPrimary(now))
        {
            var frame = primary.Capture(monitor);
            if (frame is not null)
            {
                _policy.RecordSuccess();
                return frame;
            }

            // Careful: counted only when it is the engine's fault. If "nothing moved on screen"
            // were counted, DXGI would go into a permanent pause on a quiet office PC, and it would
            // be asleep exactly when someone played video.
            if (primary.LastFailureWasEngineFault) _policy.RecordFailure(now);
        }

        // Careful: if the fallback fails it still returns null: there is nothing more to do here.
        // Both engines failing means the problem is not the engine's (session 0, a monitor that
        // does not exist, or the middle of a logoff), and no fake image is made to cover it.
        return fallback.Capture(monitor);
    }

    public void Dispose()
    {
        primary.Dispose();
        fallback.Dispose();
    }
}
