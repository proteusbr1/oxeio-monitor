using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Native;
using oXeio.Agent.Platform;
using oXeio.Agent.Security;
using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Agent.Ui;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent;

/// <summary>
/// Two forms:
///
/// <list type="bullet">
/// <item><b>With no arguments:</b> the full agent. The tray icon shows, not a console.</item>
/// <item><c>--diagnose</c>: a tool for checking Win32 and capture, writing results to the
/// console.</item>
/// </list>
///
/// Careful: the project is <c>WinExe</c>, so there is no console automatically. This is deliberate:
/// with <c>Exe</c>, a black console window would sit open on every PC at every logon, and if staff
/// closed it the agent would die too. For <c>--diagnose</c> the console is attached by hand.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class Program
{
    /**
     * The version is read **from the assembly**, not written by hand.
     *
     * Careful: there used to be a `const string Version = "0.1.0"` here, and the MSI's version came
     * from a separate variable in `installer/build.ps1`. There was no link between them: even when
     * the MSI shipped 0.2.0, the agent called itself 0.1.0 in its heartbeat. The server decides
     * update offers from that value (G59), so a machine that had already updated was offered the
     * same update again and again, and the H04 rollout would never finish.
     *
     * Now there is one source: `agent/Directory.Build.props`.
     */
    private static readonly string Version = ReadVersion();

    /// <summary>
    /// Careful: the SDK often appends `+<commit>` to `InformationalVersion` (SourceLink). Sending
    /// that to the server would break version comparison, because `rollout.ts` reads SemVer, so
    /// everything after the `+` is trimmed.
    ///
    /// Careful: if nothing is found, `"0.0.0"`, not an empty string. If sent empty, the server
    /// would treat it as "version not reported" and keep the previous one (G59), and the problem
    /// would hide even deeper.
    /// </summary>
    private static string ReadVersion() =>
        TrimBuildMetadata(
            typeof(Program).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion);

    /// <summary>
    /// Careful: this is not a guess but measured: in this repo the assembly's <c>ProductVersion</c>
    /// comes as <c>0.1.0+ef685e42b940...</c>. Sending all of that to the server would break
    /// <c>rollout.ts</c>'s SemVer comparison, and update decisions would become random.
    /// </summary>
    internal static string TrimBuildMetadata(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "0.0.0";

        var plus = raw.IndexOf('+', StringComparison.Ordinal);
        var trimmed = (plus < 0 ? raw : raw[..plus]).Trim();

        return trimmed.Length == 0 ? "0.0.0" : trimmed;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Any(a => a.Equals("--diagnose", StringComparison.OrdinalIgnoreCase)))
        {
            AttachOrAllocConsole();
            return Diagnostics.Run();
        }

        if (args.Any(a => a.Equals("--prepare-data-dir", StringComparison.OrdinalIgnoreCase)))
        {
            AttachOrAllocConsole();
            return PrepareDataDir();
        }

        if (args.Any(a => a.Equals("--preview-today", StringComparison.OrdinalIgnoreCase)))
        {
            return PreviewToday(args);
        }

        if (args.Any(a => a.Equals("--preview-signin", StringComparison.OrdinalIgnoreCase)))
        {
            return PreviewSignIn(args);
        }

        return RunAgent();
    }

    /// <summary>
    /// Open the sign-in window with fake replies and look at it: a dev tool like
    /// <c>--preview-today</c>. No server is needed and nothing is stored.
    ///
    /// Why it is needed: the window has four states, and seeing them on a real server would need,
    /// respectively, a wrong password, an account with 2FA, an owner account and a dead network.
    ///
    /// <c>--preview-signin [wrong|totp|forbidden|offline]</c>
    /// </summary>
    private static int PreviewSignIn(string[] args)
    {
        var which = args.FirstOrDefault(
            a => a is "wrong" or "totp" or "forbidden" or "offline") ?? "ok";

        var totpAsked = false;

        using var form = new SignInForm(
            "https://monitor.example.com",
            (email, _, totp, _) =>
            {
                var result = which switch
                {
                    "wrong" => new EnrollmentResult(
                        EnrollmentStatus.SignInRejected, "Email or password is incorrect."),

                    "forbidden" => new EnrollmentResult(
                        EnrollmentStatus.SignInRejected,
                        "This account is not linked to a staff record. Sign in with the staff account for this PC."),

                    "offline" => new EnrollmentResult(
                        EnrollmentStatus.ServerUnreachable,
                        "Could not reach the server: connection refused"),

                    // Careful: the first round asks for a code and the second accepts it, so both
                    // steps can be seen
                    "totp" when !totpAsked && string.IsNullOrWhiteSpace(totp) => Ask(),

                    _ => new EnrollmentResult(
                        EnrollmentStatus.Enrolled,
                        $"Enrolment succeeded — {email}", 1, "OX-001"),
                };

                return Task.FromResult(result);

                EnrollmentResult Ask()
                {
                    totpAsked = true;
                    return new EnrollmentResult(
                        EnrollmentStatus.NeedsTotp,
                        "Enter the 6-digit code from your authenticator app.");
                }
            });

        /**
         * Careful: when a state is requested, the window presses "Sign in" once by itself, so that
         * the wrong-password or 2FA look can be photographed too (in `--preview-today` the states
         * come as data; here a click is needed).
         *
         * Careful: `SendKeys` was tried first and **did not work**, silently: the keystroke goes to
         * the foreground window, and there is no guarantee that is our window. Finding the button
         * in `Controls` and calling `PerformClick()` directly is the only sure way, and it does not
         * involve the input system at all.
         */
        if (which != "ok")
        {
            form.Shown += (_, _) => form.Controls
                .OfType<Button>()
                .FirstOrDefault()
                ?.PerformClick();
        }

        Application.Run(form);

        Console.WriteLine(form.Result is { } r ? $"result: {r.Status} — {r.Message}" : "closed");
        return 0;
    }

    /// <summary>
    /// Open the "Today's hours" window with sample data and look at it: a dev tool like
    /// <c>--diagnose</c>. Nothing is stored and nothing goes to the server.
    ///
    /// Why it is needed: the window has four states (month unknown, normal, not reaching the
    /// server, target met), and seeing them on real data would need, respectively, a fresh logon,
    /// half an hour of work, disconnecting the network and a whole month. That cannot be done every
    /// time the design changes.
    ///
    /// <c>--preview-today [loading|failing|met|signin]</c>
    ///
    /// Careful: <c>signin</c> is the G79 state (not signed in). Seeing it on real data would need a
    /// fresh install and sitting there <b>without</b> signing in.
    /// </summary>
    private static int PreviewToday(string[] args)
    {
        var which = args
            .FirstOrDefault(a => a is "loading" or "failing" or "met" or "signin") ?? "working";

        using var fonts = new TrayFonts();

        var options = new TrayOptions
        {
            AgentVersion = Version,
            ServerUrl = "http://localhost:3000",
            DeviceId = 58,
            EmployeeName = "Sumaiya",
            EmpCode = "OX-07",
        };

        using var form = new TodayForm(fonts, () => options);
        form.Apply(SampleStatus(which));

        // Careful: the position is set **after showing**. Otherwise, before the handle is created,
        // Width is still WinForms' default, the calculation uses that wrong size, and the window
        // runs past the right edge of the screen. TrayIcon calls in the same order (Show, then
        // PositionNearTray, then Activate).
        form.Shown += (_, _) => form.PositionNearTray();

        Application.Run(form);
        return 0;
    }

    /// <summary>
    /// Careful: <c>Enrolled</c> is set explicitly in every sample, because in
    /// <see cref="AgentStatus.Starting"/> it is <c>false</c> (credentials had not been read at
    /// startup). Without it **every preview** would show "Not signed in", and the whole way of
    /// checking the tray's design would be useless.
    /// </summary>
    private static AgentStatus SampleStatus(string which) => which switch
    {
        // The G79 state: red dot, "Not signed in", and counting stopped. This is the only way to
        // see the design, because producing the real state would need a fresh install and sitting
        // there **without** signing in.
        "signin" => AgentStatus.Starting with
        {
            State = SegmentState.Active,
            MonthlyKnown = false,
            Enrolled = false,
        },

        "loading" => AgentStatus.Starting with
        {
            Enrolled = true,
            State = SegmentState.Active,
            ActiveToday = TimeSpan.FromMinutes(72),
            MonthlyKnown = false,
        },

        "failing" => AgentStatus.Starting with
        {
            Enrolled = true,
            State = SegmentState.Idle,
            ActiveToday = TimeSpan.FromMinutes(348),
            ActiveThisMonth = TimeSpan.FromMinutes(5780),
            MonthlyKnown = true,
            Pace = TimeSpan.FromMinutes(980),
            QueueDepth = 2481,
            Health = SyncHealth.Failing,
            LastSyncAt = DateTimeOffset.UtcNow.AddHours(-2),
        },

        "met" => AgentStatus.Starting with
        {
            Enrolled = true,
            State = SegmentState.Locked,
            ActiveToday = TimeSpan.FromMinutes(446),
            ActiveThisMonth = TimeSpan.FromMinutes(12675),
            MonthlyKnown = true,
            Pace = TimeSpan.FromMinutes(195),
            LastSyncAt = DateTimeOffset.UtcNow.AddMinutes(-1),
        },

        // Careful: the default is deliberately the owner's real situation: a little work at the
        // start of the month, so the meter's fill is 0.3%, exactly the case where the fill could
        // round down to zero.
        _ => AgentStatus.Starting with
        {
            Enrolled = true,
            State = SegmentState.Active,
            ActiveToday = TimeSpan.FromMinutes(7),
            ActiveThisMonth = TimeSpan.FromMinutes(42),
            MonthlyKnown = true,
            Pace = TimeSpan.FromMinutes(-4757),
            DailyTarget = TimeSpan.FromHours(8),
            ActiveLast7 = TimeSpan.FromMinutes(750),
            Last7Target = TimeSpan.FromHours(48),

            // Careful: real values, taken from today's run, not invented. The zero is deliberate
            // too: how a "0% busy" cell looks on screen is the very thing to see.
            RecentBusy = [41, 16, 0, 35, 72, 7],

            LatestShotThumb = Path.Combine(
                OutboxPaths.Default.State, "last-shot.webp"),
            LatestShotAt = DateTimeOffset.UtcNow.AddMinutes(-2),
            LatestShotMonitors = 2,

            LastSyncAt = DateTimeOffset.UtcNow.AddMinutes(-1),
        },
    };

    /// <summary>
    /// Once, at MSI install time, with admin rights.
    ///
    /// <b>Why the installer must do this:</b> under ProgramData's default ACL an ordinary user can
    /// change only files <b>they created</b>. If the installer (admin) created the folder and left,
    /// the agent running in the staff account could not write its SQLite queue there at all: every
    /// INSERT would fail with <c>SQLITE_READONLY</c>, and the agent would quietly store nothing.
    ///
    /// So the folder is created through <see cref="AgentDataDirectory.Ensure"/>, which gives Users
    /// Modify. The ACL rule lives in one place; written separately in WiX, the two definitions
    /// would drift apart one day.
    /// </summary>
    private static int PrepareDataDir()
    {
        var path = AgentDataDirectory.Default;

        if (!AgentDataDirectory.TryEnsure(path, out var error))
        {
            Console.Error.WriteLine($"❌ Could not create {path}: {error}");
            return 4;
        }

        Console.WriteLine($"✅ Data folder ready: {path}");
        return 0;
    }

    private static int RunAgent()
    {
        var settings = AgentSettings.Load(out var source);
        if (settings is null)
        {
            // Careful: it must not shut down silently. If the installer did not write the config,
            // or wrote it wrongly, the agent would quietly do nothing, and someone would find out a
            // week later that there was no data at all from that PC.
            Complain(
                "oXeio agent could not start",
                $"Server address not found.\n\nLooked in: {source}\n\n" +
                $"The installer is supposed to write this. Please tell office IT.");
            return 2;
        }

        using var window = new MessageWindow(OnMessage);
        using var session = new SessionMonitor(window.Handle);
        using var power = new PowerMonitor(window.Handle);

        _power = power;

        /*
         * H08: **there used to be `ConsoleSyncLog.Instance` here**, and the project is `WinExe`, so
         * **there is no console at all**. Every log line of the agent went into the void:
         * enrollment failure, token revocation, 422 rejections, none of it left any trace. Yet the
         * runbook said to read `agent.log` when there was a problem, and that file was never
         * written.
         */
        var paths = OutboxPaths.Default;
        var log = new FileLog(paths.Logs);
        log.Startup(Version, settings.ServerUrl, paths.Root);

        _host = new AgentHost(settings, Version, log);

        if (!_host.TryStart(window.Handle, out var error))
        {
            Complain("oXeio agent could not start", error ?? "Reason unknown");
            return 3;
        }

        session.TryRegister();
        power.TryRegister();

        Application.Run();

        // Careful: <b>this work cannot be done in the ApplicationExit event</b>, although that
        // looks like the natural place. The event handler would be <c>async void</c>: at the first
        // <c>await</c> it returns, WinForms assumes the work is done, <c>Application.Run()</c>
        // returns, <c>Main</c> returns and the process dies. So the rest of DisposeAsync (closing
        // the open segment, the <c>agent_stop</c> event, the final drain) would <b>never</b> run.
        // Waiting synchronously after Run() returns is the only reliable way.
        Shutdown();
        return 0;
    }

    /// <summary>
    /// Only as much time as is available at shutdown, and no more.
    ///
    /// Careful: Windows' shutdown budget is a few seconds for all processes combined. Without a
    /// ceiling, a hung drain would get us killed by Windows, and then the <c>agent_stop</c> event
    /// would not go out either: the very thing this wait exists for would be lost.
    /// </summary>
    private static void Shutdown()
    {
        var host = Interlocked.Exchange(ref _host, null);
        if (host is null) return;

        try
        {
            var closing = host.DisposeAsync().AsTask();
            if (!closing.Wait(ShutdownBudget))
            {
                // Careful: it is not thrown, only released. An exception here would change the exit
                // code, and the watchdog would treat that as a crash and restart the agent, right
                // in the middle of the shutdown.
                return;
            }
        }
        catch (Exception)
        {
            // shutting down; nobody is there to hear a complaint
        }
    }

    /// <summary>Less than Windows' ~5 seconds, so that we step aside first ourselves.</summary>
    internal static readonly TimeSpan ShutdownBudget = TimeSpan.FromSeconds(4);

    private static AgentHost? _host;
    private static PowerMonitor? _power;

    /// <summary>
    /// Careful: this handler runs on the UI thread. No network or disk work may be done here: it
    /// would freeze the whole desktop during lock/unlock.
    /// </summary>
    private static void OnMessage(Message m)
    {
        switch (m.Msg)
        {
            case Win32.WM_WTSSESSION_CHANGE:
                _host?.OnSessionChange((int)m.WParam);
                break;

            case Win32.WM_POWERBROADCAST:
                _host?.OnPower(_power?.Interpret(m.WParam, m.LParam, DateTimeOffset.UtcNow));
                break;

            // G02: the only place that tells logoff and PC shutdown apart. Careful: here we only
            // put it on the queue; trying to send would freeze the desktop and Windows would kill
            // both.
            case Win32.WM_ENDSESSION:
                _host?.OnSessionEnd(SessionMonitor.InterpretEndSession(m.WParam, m.LParam));
                break;
        }
    }

    // ── Console and messages ─────────────────────────────────────────────

    private const uint AttachParentProcess = 0xFFFFFFFF;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachConsole(uint processId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllocConsole();

    /// <summary>
    /// If run from a terminal, write to that terminal's console, otherwise to a new one. If both
    /// fail, carry on quietly: even if the output cannot be seen, the diagnostic can still run.
    /// </summary>
    private static void AttachOrAllocConsole()
    {
        if (!AttachConsole(AttachParentProcess)) AllocConsole();
    }

    private static void Complain(string title, string body)
    {
        // Careful: MessageBox is used only when it **cannot start at all**. During normal running
        // there are no pop-ups: the tray icon is the only face.
        try
        {
            MessageBox.Show(body, title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception)
        {
            // no desktop (service/session 0): nothing to show
        }
    }
}
