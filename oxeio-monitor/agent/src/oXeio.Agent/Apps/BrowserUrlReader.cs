using System.Diagnostics;
using System.Runtime.Versioning;
using System.Windows.Automation;

using oXeio.Core.Apps;

namespace oXeio.Agent.Apps;

/// <summary>
/// Reading the address from the browser's address bar (D03,
/// [ADR-013](../../../../docs/history/05-Options-Decisions.md)).
///
/// <b>Only the domain of what is read survives:</b>
/// <see cref="oXeio.Core.Apps.DomainParser"/> trims the path, query and credentials. Even if a full
/// URL comes out of here, it is stored nowhere.
///
/// <b>Why not an extension:</b> building and maintaining separate extensions for three browsers,
/// and installing them on every PC, costs far more. UI Automation is part of Windows; nothing needs
/// installing.
///
/// Careful: <b>this can fail, and that is normal.</b> The address bar's AutomationId changes
/// between browser versions. On failure it returns <c>null</c> and that usage is recorded without a
/// domain: we learn "Chrome 20 minutes" but not which site.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class BrowserUrlReader
{
    /// <summary>
    /// Careful: a hard limit. UI Automation can <b>hang for several seconds</b> in a busy or stuck
    /// app. If the tracking loop waited that long, the per-second count would fall behind.
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(400);

    private int _consecutiveFailures;

    /// <summary>
    /// After this many consecutive failures, stop trying. UI Automation is not working on this
    /// machine (accessibility off, or blocked by policy), and there is no point wasting 400 ms on
    /// every window change.
    /// </summary>
    private const int GiveUpAfter = 20;

    public bool Disabled => _consecutiveFailures >= GiveUpAfter;

    /// <summary>On failure <c>null</c>: an exception never escapes.</summary>
    public string? TryRead(nint hwnd)
    {
        if (hwnd == 0 || Disabled) return null;

        try
        {
            // Careful: in a separate task, with a hard timeout, so that if UIA hangs it does not
            // drag the caller with it.
            var task = Task.Run(() => ReadAddressBar(hwnd));

            if (!task.Wait(Timeout))
            {
                // Careful: the task is abandoned, not stopped: a UIA call cannot be cancelled. It
                // will finish in its own time and its result is discarded.
                Fail();
                return null;
            }

            var url = task.Result;
            if (string.IsNullOrWhiteSpace(url)) { Fail(); return null; }

            _consecutiveFailures = 0;
            return url;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Debug.WriteLine($"could not read the address bar: {ex.Message}");
            Fail();
            return null;
        }
    }

    private void Fail()
    {
        if (_consecutiveFailures < GiveUpAfter) _consecutiveFailures++;
    }

    private static string? ReadAddressBar(nint hwnd)
    {
        var window = AutomationElement.FromHandle(hwnd);
        if (window is null) return null;

        var edits = window.FindAll(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));

        if (edits.Count == 0) return null;

        var index = AddressBarMatcher.Pick(
            edits.Count,
            i => edits[i].Current.ClassName,
            i => edits[i].Current.AutomationId,
            i => edits[i].Current.Name);
        return index is { } i ? ValueOf(edits[i]) : null;
    }

    private static string? ValueOf(AutomationElement element)
    {
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)) return null;

        return (pattern as ValuePattern)?.Current.Value;
    }
}
