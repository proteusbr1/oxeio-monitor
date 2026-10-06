namespace oXeio.Core.Agent;

/// <summary>
/// One event: an element of <c>events[]</c> in <c>POST /agent/events</c>.
///
/// Events are a <b>log of what happened</b>, not the hours calculation. Hours come only from
/// <see cref="oXeio.Core.Models.ActivitySegment"/>. So losing an event does not move payroll;
/// it only makes debugging harder.
/// </summary>
public sealed record AgentEventRecord
{
    public required Guid ClientUuid { get; init; }

    /// <summary>One of <see cref="AgentEventTypes"/>. At most 50 characters.</summary>
    public required string Type { get; init; }

    public required DateTimeOffset OccurredAt { get; init; }

    /// <summary>
    /// Sent as a JSON object. Keep it small: it holds diagnostics, not data.
    ///
    /// Careful: never put file names, URLs or window text here. The meta field has no
    /// validation, so "just a bit of debug info" is the easiest way to sidestep the privacy rules.
    /// </summary>
    public IReadOnlyDictionary<string, object?>? Meta { get; init; }
}

/// <summary>
/// The same list as in the server's <c>schema.prisma</c>. Typing the strings by hand would
/// let one typo send a wrong type all month, and the server would accept it.
/// </summary>
public static class AgentEventTypes
{
    public const string AgentStart = "agent_start";
    public const string AgentStop = "agent_stop";
    public const string Logon = "logon";
    public const string Logoff = "logoff";

    /// <summary>
    /// PC shutdown/restart, distinct from <c>logoff</c>.
    ///
    /// The server's G02 alert (<c>alerts.rules.ts</c>) treats an <c>agent_stop</c> as "normal"
    /// <b>only</b> when a <c>logoff</c> or <c>shutdown</c> is nearby. If neither were sent,
    /// every normal nightly shutdown would count as an "intervention" and raise an alert:
    /// 15 false alerts a day from 15 PCs, after which nobody would read alerts any more.
    /// </summary>
    public const string Shutdown = "shutdown";

    /// <summary>
    /// <b>The Restart Manager is making us shut down, usually to install an update.</b>
    ///
    /// Important: this is <b>not the end of a session</b>, so it could not be called
    /// <see cref="Shutdown"/>; doing so would leave a bogus "PC shut down" record on every update.
    ///
    /// But sending nothing was wrong too, and that is what used to happen. Updates fell into the
    /// trap described in the <see cref="Shutdown"/> note: an <c>agent_stop</c> went out with no
    /// <c>logoff</c>/<c>shutdown</c> beside it, so the server's G02 treated every update as an
    /// <b>intervention</b> and raised an <c>agent_killed</c> alert. Updating one or two PCs by
    /// hand went unnoticed; once the rollout started, it was 12 at a time.
    ///
    /// The server treats this as a <b>valid companion</b> of <c>agent_stop</c>
    /// (<c>alerts.rules.ts</c> → <c>CLEAN_STOP_CONTEXT</c>), just as it does <c>logoff</c>/<c>shutdown</c>.
    ///
    /// Careful: if someone kills the agent this event is not sent, so a real intervention is
    /// still caught. The exemption covers only the path Windows itself uses to make us stop.
    /// </summary>
    public const string AgentUpdate = "agent_update";

    public const string Lock = "lock";
    public const string Unlock = "unlock";
    public const string Sleep = "sleep";
    public const string Resume = "resume";
}
