using System.Globalization;
using System.Runtime.Versioning;
using System.Text;

namespace oXeio.Watchdog.Platform;

/// <summary>
/// The <b>visible</b> sign of giving up: <c>%ProgramData%\oXeio\watchdog.alarm</c>.
///
/// <b>Why a file, and why this is enough:</b> writing to the Windows Event Log on .NET 8
/// needs a separate NuGet package, and no new packages may be added to this codebase.
/// And the real signal is already in the server's hands: when the agent stops, heartbeats
/// stop arriving, and when the server hears nothing for 10 minutes it alerts the owner
/// (02-Workflow, alert table). This file is the <b>answer</b> to that alert: the admin comes
/// to the machine and sees at a glance what the reason was.
///
/// The file must be deleted once the agent is healthy again, or six months later someone
/// will find it and chase an incident from last March.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class AlarmFile
{
    public static void Raise(string path, string reason)
    {
        try
        {
            var text = string.Create(
                CultureInfo.InvariantCulture,
                $"""
                 oXeio watchdog — the agent cannot be kept running
                 Time    : {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}
                 Machine : {Environment.MachineName}
                 User    : {Environment.UserName}
                 Reason  : {reason}

                 Restart attempts have been paused so the CPU is not burned. One attempt
                 will still be made every few hours. See watchdog.log.
                 """);

            File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
        }
        catch (Exception)
        {
            // Failing to write the alarm is unfortunate, but no reason to stop guarding.
        }
    }

    public static void Clear(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception)
        {
        }
    }
}
