namespace oXeio.Agent.Ui;

/// <summary>
/// Balloon notifications of each class are shown at most once an hour.
///
/// Why so strict: when sync fails it is usually not a one-off; if the site's internet goes
/// down it lasts for hours. Showing a balloon every time would first annoy staff, and then
/// they would silence this app from Windows's notification settings. Then the one urgent
/// message we could show next to the red icon is gone for good, and there is nothing in
/// the code that can fix that.
///
/// Careful: time is measured with the elapsed time of
/// <see cref="oXeio.Core.Time.MonotonicClock"/>, not <c>DateTimeOffset.UtcNow</c>. If someone
/// set the PC clock back, a UtcNow-based calculation would keep the balloon silent
/// indefinitely.
/// </summary>
internal sealed class BalloonThrottle
{
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromHours(1);

    private readonly Dictionary<string, TimeSpan> _lastShown = new(StringComparer.Ordinal);
    private readonly TimeSpan _interval;

    public BalloonThrottle(TimeSpan? interval = null)
    {
        var value = interval ?? DefaultInterval;
        _interval = value > TimeSpan.Zero ? value : DefaultInterval;
    }

    /// <param name="eventClass">
    /// A constant string: <c>"sync_failing"</c>, <c>"revoked"</c>… Careful: never append
    /// anything variable here (such as the queue depth): every distinct value would become a
    /// separate class, so the throttle would effectively disappear <b>and</b> the dictionary
    /// would grow month after month.
    /// </param>
    /// <param name="elapsed">Time elapsed since the agent started.</param>
    public bool ShouldShow(string eventClass, TimeSpan elapsed)
    {
        if (string.IsNullOrEmpty(eventClass)) return false;

        if (_lastShown.TryGetValue(eventClass, out var previous) &&
            elapsed - previous < _interval)
        {
            return false;
        }

        _lastShown[eventClass] = elapsed;
        return true;
    }
}
