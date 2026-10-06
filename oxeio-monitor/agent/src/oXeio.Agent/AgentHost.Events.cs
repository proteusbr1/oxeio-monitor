using System.Diagnostics;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Apps;
using oXeio.Agent.Native;
using oXeio.Agent.Platform;
using oXeio.Agent.Platform.Capture;
using oXeio.Agent.Security;
using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Agent.Ui;
using oXeio.Core.Agent;
using oXeio.Core.Capture;
using oXeio.Core.Models;
using oXeio.Core.Time;
using oXeio.Core.Tracking;

namespace oXeio.Agent;

/// <summary>Agent events (start, stop, closing) sent to the server.</summary>
internal sealed partial class AgentHost
{
    /// <summary>
    /// Puts an <see cref="AgentEventRecord"/> <b>on the queue</b>, not on the network.
    ///
    /// <b>That is the whole reason for this method.</b> Goodbye events (logoff, shutdown,
    /// agent_stop) are created exactly when Windows has about 2 seconds left for all processes
    /// combined. An HTTP call at that moment could hang on DNS or TCP, Windows would kill the
    /// process, and the event would be <b>lost</b>: the event the whole system exists for would be
    /// the one most likely to vanish. Queuing is a SQLite insert of a few dozen microseconds;
    /// sending is done by DisposeAsync's final drain or the next startup.
    ///
    /// Careful: it is not <c>await</c>ed, because the caller may be the UI thread (WM_ENDSESSION).
    /// <see cref="SqliteOutboxStore.EnqueueAsync"/> uses <c>ConfigureAwait(false)</c> inside, so
    /// the real write goes to the thread pool and the desktop is not blocked.
    /// </summary>
    private Task RaiseEvent(string type, IReadOnlyDictionary<string, object?>? meta = null) =>
        RaiseEvent(new AgentEventRecord
        {
            ClientUuid = Guid.NewGuid(),
            Type = type,
            OccurredAt = DateTimeOffset.UtcNow,
            Meta = meta,
        });

    /// <returns>A task that completes when the disk write is done; the goodbye path waits on
    /// it.</returns>
    private Task RaiseEvent(AgentEventRecord record)
    {
        if (_outbox is null) return Task.CompletedTask;

        // Careful: no events before sign-in either; the rule is "nothing goes out", not partial.
        // These are all goodbye events (agent_stop, logoff, shutdown), so a machine that never
        // signed in would pile up exactly one row, but it would go out under **someone's** name if
        // they signed in later.
        //
        // Careful: also dropped on revoke: the token is deleted, so the row could never reach the
        // server and would only grow the outbox (same reasoning as StopTrackingForRevoke).
        if (!TrackingGate.Allows(
                _credentials?.IsEnrolled == true,
                _credentials?.IsRevoked == true))
        {
            return Task.CompletedTask;
        }

        var queued = _outbox.EnqueueAsync(OutboxCodec.Item(record, DateTimeOffset.UtcNow));

        queued.ContinueWith(
            t => _log.Error($"Could not queue the event ({record.Type})", t.Exception),
            TaskContinuationOptions.OnlyOnFaulted);

        // R29-B: the write is **returned**, so the goodbye path can know whether the row really
        // reached the disk.
        //
        // Careful: failure is swallowed here (the `ContinueWith` above reports it). The caller puts
        // this in `WaitAsync`, and if a failed task threw there, a needless exception would rise at
        // the moment of goodbye.
        //
        // Careful: **no field chain is kept**, on purpose. The first draft had `_pendingEnqueue =
        // Task.WhenAll(previous, ...)`, which looks harmless, but it lengthened the chain with
        // every event and no task could ever be collected. With thousands of events a day that is a
        // **memory leak**. The goodbye path only waits for **its own two** writes, and it can hold
        // those by hand.
        return queued.ContinueWith(static _ => { }, TaskScheduler.Default);
    }

    /// <summary>
    /// The body of <c>agent_stop</c>. It is built from both paths (WM_ENDSESSION and DisposeAsync),
    /// so it lives in one place; otherwise one day one path would set <c>reason</c> and the other
    /// would not, and the server would suspect that machine.
    /// </summary>
    private AgentEventRecord BuildStopEvent() => new()
    {
        ClientUuid = Guid.NewGuid(),
        Type = AgentEventTypes.AgentStop,
        OccurredAt = DateTimeOffset.UtcNow,
        Meta = new Dictionary<string, object?>
        {
            ["agentVersion"] = _version,

            // Careful: the only clue to why it is stopping. "unknown" means neither logoff nor
            // shutdown arrived; the server will then treat it as suspicious, which is the intent.
            ["reason"] = ClosingReason(),
        },
    };

    /// <summary>
    /// A goodbye event: once in a lifetime.
    ///
    /// Careful: once <c>shutdown</c> is recorded, a later <c>logoff</c> is suppressed. When Windows
    /// shuts down, the session's logoff broadcast also arrives, but it is one event: the PC is
    /// shutting down. Writing two rows would make the log read as if the staff member logged off
    /// first and then someone shut down the PC.
    /// </summary>
    /// <returns>Whether it was actually queued.</returns>
    private bool RaiseClosingEvent(string type, IReadOnlyDictionary<string, object?>? meta = null) =>
        RaiseClosingEvent(type, out _, meta);

    /// <param name="queued">
    /// The task for the disk write to finish (R29-B). Careful: if the event is dropped it is
    /// <see cref="Task.CompletedTask"/>, so the caller does not have to handle `null`.
    /// </param>
    private bool RaiseClosingEvent(
        string type,
        out Task queued,
        IReadOnlyDictionary<string, object?>? meta = null)
    {
        queued = Task.CompletedTask;
        if (!TryMarkClosing(type)) return false;

        queued = RaiseEvent(type, meta);
        _log.Info($"Event queued: {type}");
        return true;
    }

    /// <summary>Is this the first time for this goodbye event? If so, marks it.</summary>
    private bool TryMarkClosing(string type)
    {
        lock (_closingEventsSent)
        {
            if (_closingEventsSent.Contains(type)) return false;

            if (type == AgentEventTypes.Logoff &&
                _closingEventsSent.Contains(AgentEventTypes.Shutdown))
            {
                return false;
            }

            _closingEventsSent.Add(type);
            return true;
        }
    }
}
