namespace oXeio.Agent.Ui;

/// <summary>
/// "Ahead or behind" on the window's bottom line. The number itself always comes from the
/// server (<see cref="oXeio.Core.Agent.EmployeeProgress.PaceSec"/>): it is the dashboard's
/// number, worked out with the real working days — weekly days off, holidays and leave — which
/// the agent does not know. If the server says nothing, nothing is shown: a guess made without
/// those days would disagree with the dashboard, and two numbers in two places make staff
/// assume one is lying.
/// </summary>
internal static class MonthlyPace
{
    /// <summary>What to write about pace on the window's bottom line.</summary>
    internal enum PaceView
    {
        /// <summary>G111: the server said no finished workday has been observed yet.</summary>
        NotObserved,

        /// <summary>The number sent by the server: the same number as the dashboard's.</summary>
        Server,

        /// <summary>No number (no target, or an old server): the line is omitted.</summary>
        None,
    }

    /// <summary>
    /// <b>Which statement is written, and in what order the decision is made.</b>
    ///
    /// Careful: <see cref="PaceView.NotObserved"/> must be checked first. In that state the
    /// server sends pace as exactly 0, and "0:00 ahead" would praise a new staff member's
    /// first day with not one observation behind it.
    ///
    /// Kept as a pure function rather than an <c>if</c> ladder inside <see cref="TodayForm"/>,
    /// so the order has assertions; WinForms drawing code cannot be reached from tests.
    /// </summary>
    /// <param name="paceObserved">
    /// <see cref="oXeio.Core.Agent.AgentStatus.PaceObserved"/>: <c>true</c> if the server did
    /// not say, so behavior with an old server is exactly as before.
    /// </param>
    /// <param name="serverPace">The server's number, or <c>null</c> if not sent.</param>
    internal static PaceView ViewFor(bool paceObserved, TimeSpan? serverPace)
    {
        // Careful: moving this branch below would silently bring G111 back
        if (!paceObserved) return PaceView.NotObserved;

        return serverPace is null ? PaceView.None : PaceView.Server;
    }
}
