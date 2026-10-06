using System.Text;

namespace oXeio.Agent.Security;

/// <summary>Where the code came from: to show in the log.</summary>
internal enum EnrollmentCodeOrigin
{
    None,
    Argument,
    DropFile,
    Environment,
    Prompt,
}

/// <summary>
/// Careful: safe even though it is a <c>record struct</c>: <see cref="Code"/> is a
/// <see cref="SecretText"/>, so the generated <c>ToString</c> prints only a fingerprint too.
/// </summary>
internal readonly record struct EnrollmentCodeLookup(
    SecretText? Code,
    EnrollmentCodeOrigin Origin,
    string? Detail)
{
    public bool Found => Code is not null && !Code.IsBlank;
}

/// <summary>
/// The enrollment code can come from any of four places. Priority: argument, drop-file,
/// environment, interactive prompt.
///
/// <b>Careful: giving the code on the command line is the worst way, yet it is placed first:</b> if
/// the admin supplies it by hand, that is their wish, and ignoring it would waste time on "why does
/// the code I gave not work". But the command line is visible in <c>Get-Process</c>/Task Manager
/// and is stored as plain text in Task Scheduler's XML, so the code stays there. That is why for
/// the installer the <b>drop-file</b> is recommended: %ProgramData%\oXeio\enroll.code, which is
/// deleted as soon as it is read.
/// </summary>
internal static class EnrollmentCodeSource
{
    public const string EnvironmentVariableName = "OXEIO_ENROLLMENT_CODE";

    /// <summary>The installer leaves the code here; it is deleted on the first read.</summary>
    public const string DropFileName = "enroll.code";

    /// <summary>
    /// Careful: never throws: not finding a code does not mean the agent stops, only that tracking
    /// continues in the not-enrolled state.
    /// </summary>
    /// <param name="allowPrompt">
    /// Whether the console may be asked. Careful: when running as a service/logon task this must be
    /// false, otherwise a process with no console would hang forever waiting for input, and nobody
    /// would notice.
    /// </param>
    public static EnrollmentCodeLookup Resolve(
        string dataDirectory,
        string? explicitCode = null,
        bool allowPrompt = false,
        Action<string>? log = null)
    {
        if (Clean(explicitCode) is { } fromArgument)
        {
            log?.Invoke(
                "⚠️ The enrolment code was taken from the command line — it stays visible in the " +
                "process list and in Task Scheduler's XML. Use " + DropFileName + " in the installer.");

            return new EnrollmentCodeLookup(
                new SecretText(fromArgument), EnrollmentCodeOrigin.Argument, "command line");
        }

        var dropFile = Path.Combine(dataDirectory, DropFileName);
        if (TryReadDropFile(dropFile, log) is { } fromFile)
            return new EnrollmentCodeLookup(new SecretText(fromFile), EnrollmentCodeOrigin.DropFile, dropFile);

        if (Clean(SafeEnvironment(EnvironmentVariableName)) is { } fromEnv)
        {
            return new EnrollmentCodeLookup(
                new SecretText(fromEnv), EnrollmentCodeOrigin.Environment, EnvironmentVariableName);
        }

        if (allowPrompt && Prompt() is { } typed)
            return new EnrollmentCodeLookup(new SecretText(typed), EnrollmentCodeOrigin.Prompt, "console");

        return new EnrollmentCodeLookup(
            null, EnrollmentCodeOrigin.None,
            $"No enrolment code found anywhere ({DropFileName} / {EnvironmentVariableName} / argument)");
    }

    /// <summary>
    /// Careful: deleted as soon as it is read. If not, the single-use code would sit in
    /// %ProgramData% for years, and every user can read that folder. If deletion fails it is
    /// reported loudly: it must not stay silent.
    /// </summary>
    private static string? TryReadDropFile(string path, Action<string>? log)
    {
        try
        {
            if (!File.Exists(path)) return null;

            var code = Clean(File.ReadAllText(path));

            try
            {
                File.Delete(path);
            }
            catch (Exception ex)
            {
                log?.Invoke($"⚠️ Could not delete {path} ({ex.GetType().Name}) — the code is still on disk, delete it by hand.");
            }

            return code;
        }
        catch (Exception ex)
        {
            log?.Invoke($"⚠️ Could not read {path}: {ex.GetType().Name}");
            return null;
        }
    }

    private static string? SafeEnvironment(string name)
    {
        try
        {
            return Environment.GetEnvironmentVariable(name);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Careful: the input is not echoed. If the code were on screen it would stay in the console's
    /// scrollback, and this very agent takes screenshots of that screen. If stdin is redirected
    /// <c>ReadKey</c> throws, so that is checked first.
    /// </summary>
    private static string? Prompt()
    {
        try
        {
            Console.Write("enrolment code: ");

            if (Console.IsInputRedirected)
            {
                var piped = Clean(Console.ReadLine());
                Console.WriteLine();
                return piped;
            }

            var builder = new StringBuilder(32);
            while (true)
            {
                var key = Console.ReadKey(intercept: true);

                if (key.Key == ConsoleKey.Enter)
                {
                    Console.WriteLine();
                    break;
                }

                if (key.Key == ConsoleKey.Escape)
                {
                    Console.WriteLine();
                    return null;
                }

                if (key.Key == ConsoleKey.Backspace)
                {
                    if (builder.Length > 0) builder.Length--;
                    continue;
                }

                // control characters are skipped, otherwise pressing an arrow key would put garbage
                // in
                if (!char.IsControl(key.KeyChar)) builder.Append(key.KeyChar);
            }

            return Clean(builder.ToString());
        }
        catch (Exception)
        {
            // no console (when running as WinExe): the prompt is skipped, not a crash.
            return null;
        }
    }

    /// <summary>
    /// Blanks are removed. Careful: nothing more is done: trying to "fix" dashes or case would no
    /// longer match the server's code, and the user would see "code wrong".
    /// </summary>
    private static string? Clean(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
