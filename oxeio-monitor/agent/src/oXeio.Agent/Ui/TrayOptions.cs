using oXeio.Core.Agent;

namespace oXeio.Agent.Ui;

/// <summary>
/// Everything the tray knows, and no more. Beyond this it asks nothing and calls nothing.
///
/// Careful: there is deliberately no <c>ISyncClient</c>, <c>IOutboxStore</c> or tracking loop
/// here. The tray only draws what it receives through <see cref="IAgentStatusSink"/>.
/// Once it were allowed to call the server there would be two kinds of "truth" in two places,
/// and a tray bug could corrupt the hours calculation.
///
/// The tray starts showing before enrollment (the icon must always be visible), so
/// <see cref="DeviceId"/> and the employee details are null at first and are set later
/// through <see cref="TrayIcon.UpdateOptions"/>.
/// </summary>
internal sealed record TrayOptions
{
    public required string AgentVersion { get; init; }

    /// <summary>The server's base URL; only to show in the "About" window.</summary>
    public required string ServerUrl { get; init; }

    /// <summary>Null before enrollment.</summary>
    public int? DeviceId { get; init; }

    public string? EmployeeName { get; init; }

    public string? EmpCode { get; init; }

    /// <summary>"My details": the staff portal URL. If empty the menu item is disabled.</summary>
    public string? StaffPortalUrl { get; init; }

    /// <summary>
    /// "View policy": an http(s) URL, or the path of a locally installed document.
    /// Careful: whatever is given, <see cref="TrayIcon"/> does not blindly ShellExecute it;
    /// it validates the scheme and extension.
    /// </summary>
    public string? PolicyUrl { get; init; }

    /// <summary>
    /// The config; only to show the screenshot time window in the "About" window. If null,
    /// <see cref="AgentConfig.Default"/> is used.
    /// </summary>
    public AgentConfig? Config { get; init; }

    /// <summary>
    /// What is called when "Sync now" is pressed.
    ///
    /// Careful: this is <b>not</b> called on the UI thread; it is dropped onto the thread
    /// pool. So it is fine for the implementation to block, but it must be thread-safe.
    /// Usually it should be something like a <c>ManualResetEventSlim.Set()</c> on the sync
    /// loop, not a direct HTTP call.
    /// </summary>
    public Action? RequestSyncNow { get; init; }

    /// <summary>
    /// Reopens the sign-in window.
    ///
    /// Careful: <b>why this was needed:</b> the window used to appear <b>only at startup</b>,
    /// once. If staff closed it (or were in a hurry on install day), the only way back was to
    /// log off and on again. After G79 the window says in large text
    /// <i>"Sign in to start counting your hours"</i>, yet there was no way to sign in.
    /// The message names the task but there is no door to do it; the owner caught exactly
    /// this in 0.3.4.
    /// </summary>
    public Action? RequestSignIn { get; init; }

    /// <summary>
    /// Installs the new, verified MSI: staff press it themselves.
    ///
    /// Careful: <b>it is not installed silently, and cannot be.</b> The agent runs with the
    /// rights of the logged-in user (<c>Group=Users</c> in the installer), and <c>msiexec</c>
    /// needs admin. So a UAC prompt is unavoidable; the only way to do it "in the background"
    /// would be a service running as SYSTEM, which is a separate and bigger decision.
    ///
    /// Careful: and that is <b>not a bad thing</b>: G58 says once a bad MSI has run there is
    /// no way back. One human click is the last barrier against that risk.
    /// </summary>
    public Action? InstallUpdate { get; init; }

    /// <summary>
    /// When staff want to sign out themselves.
    ///
    /// Careful: <b>the tray itself deletes nothing and confirms nothing</b>; it only reports.
    /// Signing out means discarding unsent rows, and finding out how many there are requires
    /// reading the outbox. Letting the tray touch the outbox would break the rule at the top
    /// of this file, and create two different answers to "how much is left". Both the decision
    /// and the question live in <c>AgentHost</c>
    /// (<see cref="oXeio.Core.Agent.SignOutGate"/>).
    ///
    /// Careful: if null the menu item is not shown; like the rule of having no "Exit" item,
    /// this too is deliberately blocked.
    /// </summary>
    public Action? RequestSignOut { get; init; }

    /// <summary>
    /// J03: the memory of which month the monthly-target balloon was shown in.
    ///
    /// Careful: if null the feature is off; the balloon does not become "every time". Without
    /// memory the show-once promise cannot be kept, and showing nothing is safer than showing
    /// a balloon on every heartbeat (<see cref="MonthlyMilestone"/>).
    ///
    /// Careful: the <b>same instance</b> must be passed in every
    /// <see cref="TrayIcon.UpdateOptions"/>; a new object would lose the cache and re-read the disk.
    /// </summary>
    public IMilestoneMemory? Milestone { get; init; }

    /// <summary>Exceptions caught in the UI go here. If null they are swallowed silently.</summary>
    public Action<Exception>? OnError { get; init; }

    public AgentConfig EffectiveConfig => Config ?? AgentConfig.Default;
}
