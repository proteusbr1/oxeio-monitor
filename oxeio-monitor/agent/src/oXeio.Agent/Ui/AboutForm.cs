using System.Globalization;
using System.Runtime.Versioning;

using oXeio.Core.Agent;

namespace oXeio.Agent.Ui;

/// <summary>
/// "About": version, device id, server.
///
/// Plus a short list of what this agent <b>does not</b> do. That is not decoration: it is
/// a place where staff can verify, on their own machine in two clicks, what the written
/// monitoring policy promises. If this window's list and the policy document ever drift
/// apart, a promise has been broken somewhere.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class AboutForm : OwnerDrawnForm
{
    private readonly Func<TrayOptions> _options;

    public AboutForm(TrayFonts fonts, Func<TrayOptions> options)
        : base(fonts, "oXeio — About", 420, 490)
    {
        _options = options;
    }

    /// <summary>
    /// Redraws once the device id is set after enrollment. Called from the UI thread.
    ///
    /// Careful: it cannot be named <c>Refresh</c>; <c>Control.Refresh()</c> already exists.
    /// If we hid it, calling through a base-class reference would run different code.
    /// </summary>
    public void RedrawContent()
    {
        if (IsDisposed || !IsHandleCreated) return;
        Invalidate();
    }

    protected override void PaintBody(TextStack stack)
    {
        var options = _options();
        var config = options.EffectiveConfig;

        stack.Line("oXeio Monitor", TrayFontRole.Strong);
        stack.Gap(6);

        stack.Pair("Version", options.AgentVersion);
        stack.Pair("Device ID", options.DeviceId is { } id
            ? UiText.Number(id)
            : "Not enrolled yet");

        if (!string.IsNullOrWhiteSpace(options.EmployeeName))
        {
            stack.Pair("Staff", options.EmpCode is { Length: > 0 } code
                ? $"{options.EmployeeName} ({code})"
                : options.EmployeeName!);
        }

        stack.Gap(4);

        // Careful: if the URL is not given on one line, TextStack breaks it into two lines by
        // itself, so Line and not Pair. With Pair, being stuck in the right half made it unreadable.
        stack.Line("Server", TrayFontRole.Small, Muted);
        stack.Line(options.ServerUrl);

        stack.Rule();

        stack.Line("What this agent does not do", TrayFontRole.Strong);
        stack.Gap(4);

        foreach (var promise in Promises(config))
        {
            stack.Line("•  " + promise, TrayFontRole.Small);
        }

        stack.Rule();

        stack.Line(
            "The tray icon is always visible — there is no setting to hide it. " +
            "Monitoring is never kept secret.",
            TrayFontRole.Small, Muted);
    }

    private static IEnumerable<string> Promises(AgentConfig config)
    {
        yield return "Does not record keystrokes";
        yield return "Does not read the clipboard";
        yield return "Does not keep full URLs — domain only";
        yield return "Does not touch the camera or microphone";
        yield return "Does not record screen video or the contents of files";
        yield return ScreenshotWindowLine(config);
        yield return "Lunch, breaks and late arrivals are not counted at all";
    }

    private static string ScreenshotWindowLine(AgentConfig config)
    {
        var from = AgentConfig.ParseHhMm(config.ScreenshotFrom);
        var to = AgentConfig.ParseHhMm(config.ScreenshotTo);

        if (from is null || to is null)
            return "The screenshot window has not arrived from the server";

        var window =
            $"{from.Value.ToString(@"HH\:mm", CultureInfo.InvariantCulture)}–" +
            $"{to.Value.ToString(@"HH\:mm", CultureInfo.InvariantCulture)}";

        // Time is counted 24 hours a day; without saying this staff think night work is not counted
        return $"Screenshots are taken only between {window} (time is still counted 24 hours a day)";
    }
}
