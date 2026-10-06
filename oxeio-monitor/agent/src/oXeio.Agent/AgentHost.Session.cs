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

/// <summary>Windows messages from the UI thread: session changes, log off, power.</summary>
internal sealed partial class AgentHost
{
    /// <summary>
    /// The raw code of <c>WM_WTSSESSION_CHANGE</c>.
    ///
    /// Careful: the code itself is taken, not the interpreted <see cref="SessionChange"/>. For
    /// tracking, lock and logoff are the same (both suspend), but for G02 they are completely
    /// different: one is "they will come back", the other "they have gone". Interpreting first
    /// would stop that difference from reaching here.
    /// </summary>
    public void OnSessionChange(int wtsCode)
    {
        var change = SessionMonitor.Interpret(wtsCode);

        if (change == SessionChange.Suspend) _sessionSuspended = true;
        else if (change == SessionChange.Resume) _sessionSuspended = false;

        if (SessionMonitor.ClosingEventType(wtsCode) is { } type)
        {
            RaiseClosingEvent(type, new Dictionary<string, object?>
            {
                // Careful: only the code and its name; no username, hostname or window text (the
                // rule of AgentEventRecord.Meta).
                ["source"] = "wts",
                ["wtsCode"] = wtsCode,
            });
        }
    }

    /// <summary>
    /// <c>WM_ENDSESSION</c>: whether it is a logoff or a PC shutdown is known right here.
    /// <see cref="SessionMonitor.InterpretEndSession"/> explains why not PowerMonitor.
    /// </summary>
    public void OnSessionEnd(string? eventType)
    {
        if (eventType is null) return;

        if (!RaiseClosingEvent(eventType, out var closingQueued, new Dictionary<string, object?>
            {
                ["source"] = "endsession",
            }))
        {
            return;
        }

        // <b>agent_stop is queued right here, not left to DisposeAsync.</b> WM_ENDSESSION means the
        // session really is ending; after it Windows kills the process, and whether
        // <c>Application.Run()</c> returns at all depends on WinForms internals. If it did not
        // return, DisposeAsync would never run, and on every normal shutdown the server would get
        // logoff/shutdown but no agent_stop: exactly the opposite gap.
        //
        // There is no fear of queuing twice: if DisposeAsync runs, TryMarkClosing stops it.
        var stopQueued = TryMarkClosing(AgentEventTypes.AgentStop)
            ? RaiseEvent(BuildStopEvent())
            : Task.CompletedTask;

        // R29-B: and the attempt to **send** happens right here.
        TryFlushGoodbye(closingQueued, stopQueued);
    }

    /// <summary>
    /// <b>R29-B: the last chance to send the goodbye event now.</b>
    ///
    /// After <c>WM_ENDSESSION</c> Windows kills the process, and there is no guarantee that
    /// <c>Application.Run()</c> returns. Field numbers say it does <b>not</b> return on an OS
    /// shutdown (the delay averages 740 minutes, meaning sending happens at the next startup). So
    /// we cannot rely on <c>DisposeAsync</c>'s priority drain; this is the last place where we are
    /// still alive.
    ///
    /// Careful: <b>the UI thread waits here, and that is this method's only risk.</b> It is bounded
    /// in three ways:
    /// <list type="bullet">
    /// <item>The work runs in <c>Task.Run</c>, on the thread pool, without the UI's
    /// <c>SynchronizationContext</c>. Careful: calling <c>.Wait()</c> directly would be a classic
    /// deadlock: the continuation would want the UI thread, and the UI thread is waiting.</item>
    /// <item>The total ceiling is <see cref="EndSessionSendBudget"/>, less than half of Windows'
    /// <c>WaitToKillAppTimeout</c> (default 5 s).</item>
    /// <item>On failure nothing is lost: the event stays in the outbox and the next startup sends
    /// it. <b>Worst case = today's behaviour.</b></item>
    /// </list>
    ///
    /// Careful: <c>ShutdownBlockReasonCreate</c> is not used, although the roadmap (R29-B) said to.
    /// It tells Windows "wait": the user sees an "oXeio is blocking shutdown" screen, and if it is
    /// released wrongly the desktop hangs. Here only a few hundred milliseconds are needed, and
    /// those are available without asking; trying the cheap path before taking an OS-level block is
    /// the right order.
    /// </summary>
    private void TryFlushGoodbye(params Task[] queued)
    {
        var worker = _worker;
        if (worker is null) return;

        var flush = Task.Run(async () =>
        {
            // Step 1: let the rows queued at this moment reach the disk
            try { await Task.WhenAll(queued).WaitAsync(EndSessionEnqueueWait); }
            catch (Exception) { /* the write did not finish; try sending anyway */ }

            // Step 2: Event only, not segments or images.
            // Careful: `DrainOnceAsync` runs Segment then Event, so with a backlog the goodbye
            // would never get time. There is a single kind here.
            using var cts = new CancellationTokenSource(EndSessionSendBudget);
            await worker.DrainKindOnceAsync(OutboundKind.Event, cts.Token);
        });

        // Careful: exceptions are swallowed. An exception thrown at the moment of goodbye would
        // reach WndProc and drop the process messily, leaving `agent_stop` sitting in the outbox:
        // exactly what this code is meant to prevent.
        try
        {
            if (!flush.Wait(EndSessionTotalBudget))
            {
                _log.Info("Goodbye send did not finish in time — the outbox keeps it");
            }
        }
        catch (Exception ex)
        {
            _log.Error("Goodbye send failed — the outbox keeps it", ex);
        }
    }

    /// <summary>
    /// The reason sent with <c>agent_stop</c>: <c>shutdown</c>, <c>logoff</c> or <c>unknown</c>.
    ///
    /// Careful: <c>unknown</c> is not covered up. "Someone killed the process" versus "the PC shut
    /// down" is the entire point of G02. When in doubt, the doubt stays in the record.
    /// </summary>
    private string ClosingReason()
    {
        lock (_closingEventsSent)
        {
            if (_closingEventsSent.Contains(AgentEventTypes.Shutdown))
                return AgentEventTypes.Shutdown;

            if (_closingEventsSent.Contains(AgentEventTypes.Logoff))
                return AgentEventTypes.Logoff;

            // Stopping for an update is also a **known** reason, not "unknown". Careful: without
            // the reason, the event would forever say "who knows why it stopped", although we knew
            // exactly.
            if (_closingEventsSent.Contains(AgentEventTypes.AgentUpdate))
                return AgentEventTypes.AgentUpdate;
        }

        return "unknown";
    }

    public void OnPower(PowerSignal? signal)
    {
        /**
         * Careful: <b>this method runs on the UI (message pump) thread</b>, not the tracker thread:
         * <c>Program.OnMessage</c> calls it directly. This was the real path behind G160: at the
         * moment the screen went to sleep, this thread and the tracker thread both entered the same
         * machine.
         *
         * Careful: <b>deliberately not deferred.</b> Leaving it like <c>_pendingConfig</c> for the
         * tracker to do would be wrong here: on a real <c>PBT_APMSUSPEND</c> the PC sleeps within
         * about 2 seconds and the tracker no longer ticks, so the open segment would be closed
         * after waking and the whole sleep would count as work. That is exactly the <b>G3</b> bug
         * that <see cref="IdleStateMachine.OnSuspend"/> was written to prevent.
         */
        IReadOnlyList<ActivitySegment>? closed = null;

        if (signal is PowerSignal.Suspend or PowerSignal.DisplayOff)
        {
            // About 2 seconds are left before sleep: only close the segment, no network calls.
            lock (_machineGate) closed = _machine?.OnSuspend(_clock.Now);
            _sleep.Reset();
        }
        else if (signal == PowerSignal.Resume)
        {
            lock (_machineGate) closed = _machine?.OnResume(_clock.Now);
            _sleep.Reset();
        }

        // Careful: **outside** the lock: this writes to SQLite (see `_machineGate` above)
        if (closed is not null) Record(closed);
    }
}
