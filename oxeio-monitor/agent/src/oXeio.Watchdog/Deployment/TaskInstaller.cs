using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;

namespace oXeio.Watchdog.Deployment;

/// <summary>
/// H02: installing the logon task in Task Scheduler.
///
/// This is a <b>one-shot CLI mode</b> (<c>--install-task</c>), run once by the installer.
/// <c>schtasks</c> is never called from the guard loop: that would create an extra process
/// every 30 seconds and load the Task Scheduler service, when the task is something you
/// install once.
///
/// The XML lives as an embedded resource so the exe and its deployment rules can never drift
/// apart.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class TaskInstaller
{
    internal const string TaskName = @"\oXeio\oXeio Watchdog";

    private const string ResourceName = "oXeio.Watchdog.Task.xml";

    /// <summary>The XML from the resource, with <c>{EXE}</c>/<c>{DIR}</c> filled in and comments stripped.</summary>
    public static string RenderXml(string exePath)
    {
        var raw = ReadResource();
        var dir = Path.GetDirectoryName(exePath) ?? AppContext.BaseDirectory;

        return StripXmlComments(raw)
            .Replace("{EXE}", Escape(exePath), StringComparison.Ordinal)
            .Replace("{DIR}", Escape(dir.TrimEnd('\\')), StringComparison.Ordinal);
    }

    /// <returns>The process exit code; 0 means success.</returns>
    public static int Install(string exePath, TextWriter output)
    {
        string temp;
        try
        {
            temp = Path.Combine(Path.GetTempPath(), $"oXeio-watchdog-{Guid.NewGuid():N}.xml");

            // UTF-16 (with BOM): on some Windows builds schtasks /XML rejects a UTF-8 file with
            // "The task XML is malformed", and since the mistake is not in the XML it takes
            // hours to find.
            File.WriteAllText(temp, RenderXml(exePath), new UnicodeEncoding(false, true));
        }
        catch (Exception ex)
        {
            output.WriteLine($"Could not write the XML: {ex.Message}");
            return 4;
        }

        try
        {
            var code = RunSchtasks($"/Create /TN \"{TaskName}\" /XML \"{temp}\" /F", output);

            if (code == 0)
                output.WriteLine($"✅ Task installed: {TaskName}  →  {exePath}");
            else
                output.WriteLine($"❌ schtasks exit code {code} — was this run as administrator?");

            return code;
        }
        finally
        {
            try { File.Delete(temp); } catch (Exception) { /* a leftover temp file does no harm */ }
        }
    }

    public static int Uninstall(TextWriter output)
    {
        var code = RunSchtasks($"/Delete /TN \"{TaskName}\" /F", output);
        output.WriteLine(code == 0 ? "✅ Task deleted" : $"❌ schtasks exit code {code}");
        return code;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private static int RunSchtasks(string arguments, TextWriter output)
    {
        try
        {
            // The full path: writing just "schtasks" would run a fake exe placed on the PATH.
            // This command runs as administrator, so that would be direct privilege
            // escalation.
            var exe = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System), "schtasks.exe");

            var info = new ProcessStartInfo(exe, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using var process = Process.Start(info);
            if (process is null)
            {
                output.WriteLine("Could not start schtasks");
                return 4;
            }

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (!string.IsNullOrWhiteSpace(stdout)) output.WriteLine(stdout.Trim());
            if (!string.IsNullOrWhiteSpace(stderr)) output.WriteLine(stderr.Trim());

            return process.ExitCode;
        }
        catch (Exception ex)
        {
            output.WriteLine($"Could not run schtasks: {ex.GetType().Name} — {ex.Message}");
            return 4;
        }
    }

    private static string ReadResource()
    {
        var assembly = Assembly.GetExecutingAssembly();

        // So it is still found if the name changes: an embedded resource's name is built by
        // MSBuild's rules, and silently changes when the file is moved.
        var name = Array.Find(
            assembly.GetManifestResourceNames(),
            n => n.EndsWith(ResourceName, StringComparison.OrdinalIgnoreCase)
                 || n.EndsWith("WatchdogTask.xml", StringComparison.OrdinalIgnoreCase));

        if (name is null)
            throw new InvalidOperationException("The task XML resource was not found");

        using var stream = assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("The task XML resource could not be opened");

        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// Comments are stripped. Comments are valid in XML, but there is no point risking Task
    /// Scheduler's parser, and when it fails it only says "The task XML is malformed" without
    /// saying which line. The comments stay in the repository file, where they are needed.
    /// </summary>
    private static string StripXmlComments(string xml)
    {
        var builder = new StringBuilder(xml.Length);
        var index = 0;

        while (index < xml.Length)
        {
            var start = xml.IndexOf("<!--", index, StringComparison.Ordinal);
            if (start < 0)
            {
                builder.Append(xml, index, xml.Length - index);
                break;
            }

            builder.Append(xml, index, start - index);

            var end = xml.IndexOf("-->", start + 4, StringComparison.Ordinal);
            if (end < 0) break;   // unterminated comment: drop the rest

            index = end + 3;
        }

        return builder.ToString();
    }

    /// <summary>An <c>&amp;</c> or <c>&lt;</c> in the path would break the XML.</summary>
    private static string Escape(string value) => value
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal);
}
