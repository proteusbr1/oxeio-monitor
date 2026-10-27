using System.Runtime.Versioning;
using System.Security;
using System.Text.Json;
using System.Text.Json.Serialization;

using oXeio.Agent.Security;

namespace oXeio.Agent;

/// <summary>
/// Where the agent talks to: written by the MSI at install time.
///
/// Careful: <b>no secrets are kept here</b>. The device token is in a separate file, protected with
/// DPAPI (<see cref="DeviceTokenStore"/>). Being able to read this file only reveals the server's
/// address.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed record AgentSettings
{
    /// <summary>
    /// Example: <c>https://monitor.example.com</c>. <b>Address only</b>, no path.
    ///
    /// Careful: the API prefix (<c>/api/v1</c>) is not written here; <see cref="ApiRoot"/> adds it.
    /// That is a server internal; asking the office admin to remember it means someone will forget
    /// one day, and then the agent would get a 404 on every request and quietly send nothing.
    /// </summary>
    public required string ServerUrl { get; init; }

    /// <summary>The server's global prefix, set in <c>server/src/main.ts</c>.</summary>
    public const string ApiPrefix = "api/v1";

    /// <summary>
    /// <see cref="ServerUrl"/> + <see cref="ApiPrefix"/>. It ends with a slash, because when
    /// <c>Uri</c> joins a relative path it <b>drops the last segment</b>; without the slash,
    /// <c>.../api/v1</c> + <c>agent/enroll</c> would become <c>.../api/agent/enroll</c>.
    /// </summary>
    [JsonIgnore]
    public Uri ApiRoot => new(new Uri(ServerUrl.TrimEnd('/') + "/"), ApiPrefix + "/");

    /// <summary>Where staff can see their own data (J02). If absent, the menu item is
    /// disabled.</summary>
    public string? StaffPortalUrl { get; init; }

    /// <summary>Copy of the signed monitoring policy (J04).</summary>
    public string? PolicyUrl { get; init; }

    /// <summary>One-time code supplied at install (H05). Ignored once enrolled.</summary>
    public string? EnrollmentCode { get; init; }

    /// <summary>
    /// <b>I01:</b> the SPKI hash (base64) of the server's certificate, comma-separated.
    ///
    /// The office server uses a self-signed certificate, so there is no "trusted CA"; the pin is
    /// the only way the agent can be sure our server is on the other end (runbook section 6).
    ///
    /// Careful: <b>several pins may be set, and on renewal day they must be</b>. If the old and new
    /// certificates are not both valid for a while, all 15 agents would lose their connection at
    /// the moment the certificate changes (section 7.1).
    ///
    /// Careful: if not set, pinning is <b>off</b> and only Windows' own validation applies. This is
    /// a deliberate trade-off for now: runbook section 6.4 recommended making the pin mandatory,
    /// but that would stop today's pilot (where no certificate has been installed yet) from
    /// connecting at all. Setting `SERVERPIN` in production is part of the checklist, and when it
    /// is missing the agent says so clearly in the log.
    /// </summary>
    public string? ServerPin { get; init; }

    /// <summary>
    /// The owner's public key for agent updates (MSI property UPDATEKEY) —
    /// see <see cref="oXeio.Core.Agent.UpdateSignature"/>. Empty = updates are
    /// checked by sha256 only, as before.
    /// </summary>
    public string? UpdatePublicKey { get; init; }

    /// <summary>
    /// <b>L1:</b> plain <c>http://</c> to a non-loopback server is allowed. Only from HKLM (MSI
    /// property <c>ALLOWHTTP=1</c>, registry <c>AllowInsecureHttp</c>) or in a Debug build, never
    /// from <c>agent.json</c> or the environment, because those are writable by the user being
    /// monitored.
    ///
    /// Careful: over plain HTTP the sign-in password and the device token cross the network in
    /// clear, and anyone on the LAN can also answer as the server. That is why it is an explicit,
    /// admin-only opt-in (deploy/README.md › "Plain HTTP on the office LAN") and not simply
    /// accepted as it was before.
    /// </summary>
    [JsonIgnore]
    public bool AllowInsecureHttp { get; init; }

    /// <summary>Something the log should say about where these settings came from.</summary>
    [JsonIgnore]
    public string? LoadWarning { get; init; }

    [JsonIgnore]
    public bool IsUsable => IsAcceptableServerUrl(ServerUrl, AllowInsecureHttp);

    /// <summary>
    /// <b>L1:</b> <c>https://</c> always; <c>http://</c> only to this PC itself (<c>localhost</c>,
    /// <c>127.x</c>, <c>::1</c>: nothing leaves the machine) or when
    /// <paramref name="allowPlainHttp"/> (the HKLM opt-in, or a Debug build).
    /// </summary>
    internal static bool IsAcceptableServerUrl(string? url, bool allowPlainHttp)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme == Uri.UriSchemeHttps) return true;
        return u.Scheme == Uri.UriSchemeHttp && (allowPlainHttp || u.IsLoopback);
    }

    /// <summary>
    /// File name: in the data folder, next to the token.
    ///
    /// Careful: that folder is <b>writable by every standard user</b> (Users = Modify, see
    /// <see cref="AgentDataDirectory"/>), so this file is only read when HKLM has <b>no</b>
    /// <c>SOFTWARE\oXeio\Agent</c> key at all, i.e. on a PC where the MSI was never installed
    /// (a hand-copied dev build). On an installed PC a broken or half-written HKLM key makes the
    /// agent refuse to start rather than fall back to a file the monitored user can write.
    /// </summary>
    public const string FileName = "agent.json";

    /// <summary>
    /// <b>H2:</b> overrides the server address, for development.
    ///
    /// Careful: <b>a standard user can set this</b> (<c>HKCU\Environment</c>), and before it was
    /// checked first and won outright, returning settings with nothing but the address. That
    /// silently turned off certificate pinning (no <see cref="ServerPin"/>) and the owner's update
    /// signature (no <see cref="UpdatePublicKey"/>, so <c>UpdateSignature.Verify</c> says
    /// "not required"): the monitored user could point their own agent at any server, which
    /// could then offer an MSI the admin would approve.
    ///
    /// Now it is honoured only in a <b>Debug build</b>, or when an administrator has set
    /// <c>AllowServerUrlOverride=1</c> under <c>HKLM\SOFTWARE\oXeio\Agent</c>. And even then,
    /// the pin, the update key and the http opt-in still come from HKLM: the override changes the
    /// address and nothing else.
    ///
    /// Careful: the MSI deletes the whole key on upgrade (<c>ForceDeleteOnUninstall</c>), so the
    /// HKLM flag is gone after every update; it is a temporary switch for an admin who is at
    /// the PC, by design.
    /// </summary>
    public const string ServerUrlEnvVar = "OXEIO_SERVER_URL";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    /// <summary>The MSI writes here. Windows removes it itself on uninstall.</summary>
    public const string RegistryKey = @"SOFTWARE\oXeio\Agent";

    public static AgentSettings? Load(out string source) => Load(null, out source);

    /// <summary>
    /// If it cannot be read, it is not configured: returns <c>null</c>, not an exception, so the
    /// caller can show a clear message rather than a stack trace.
    ///
    /// It looks in these places:
    /// <list type="number">
    /// <item>registry <c>HKLM\SOFTWARE\oXeio\Agent</c>: where the MSI writes, and the only
    /// source of the pin, the update key and the http opt-in</item>
    /// <item>environment variable <see cref="ServerUrlEnvVar"/>: replaces the <b>address</b>
    /// only, and only in a Debug build or with the HKLM opt-in (see there)</item>
    /// <item><c>agent.json</c>: only when HKLM has no key at all (see <see cref="FileName"/>)</item>
    /// </list>
    ///
    /// On <c>null</c>, <paramref name="source"/> says where it looked and why nothing was usable.
    /// </summary>
    public static AgentSettings? Load(string? directory, out string source) =>
        Resolve(
            Environment.GetEnvironmentVariable(ServerUrlEnvVar),
            ReadMachineConfig(),
            () => FromFile(directory ?? AgentDataDirectory.Default),
            BuildOptions.IsDebugBuild,
            out source);

    /// <summary>What HKLM said: no key at all, a key, or an error reading it.</summary>
    internal sealed record MachineConfig
    {
        public static readonly MachineConfig Absent = new() { Exists = false };

        public bool Exists { get; init; } = true;

        /// <summary>Set when HKLM could not be read; then nothing else is trusted.</summary>
        public string? ReadError { get; init; }

        public string? ServerUrl { get; init; }
        public string? StaffPortalUrl { get; init; }
        public string? PolicyUrl { get; init; }
        public string? EnrollmentCode { get; init; }
        public string? ServerPin { get; init; }
        public string? UpdatePublicKey { get; init; }

        /// <summary><c>AllowInsecureHttp</c> (L1)</summary>
        public bool AllowInsecureHttp { get; init; }

        /// <summary><c>AllowServerUrlOverride</c> (H2)</summary>
        public bool AllowServerUrlOverride { get; init; }
    }

    /// <summary>
    /// The decision itself, free of the registry and the file system so it can be tested.
    /// </summary>
    internal static AgentSettings? Resolve(
        string? envServerUrl,
        MachineConfig machine,
        Func<(AgentSettings? Settings, string Source)> fromFile,
        bool debugBuild,
        out string source)
    {
        var hklm = $@"HKLM\{RegistryKey}";

        // Careful: if HKLM cannot be read, it is unknown whether this PC is installed. Falling
        // through to agent.json would then let a user-written file decide; refuse instead.
        if (machine.ReadError is { } error)
        {
            source = $"{hklm} (could not be read: {error})";
            return null;
        }

        var allowHttp = debugBuild || (machine.Exists && machine.AllowInsecureHttp);
        string? warning = null;

        if (!string.IsNullOrWhiteSpace(envServerUrl))
        {
            if (debugBuild || (machine.Exists && machine.AllowServerUrlOverride))
            {
                var overridden = FromMachine(machine, envServerUrl.Trim(), allowHttp) with
                {
                    LoadWarning =
                        $"⚠️ Server address taken from the environment variable {ServerUrlEnvVar} " +
                        (debugBuild ? "(Debug build)" : $"(allowed by {hklm}\\AllowServerUrlOverride)") +
                        (machine.Exists ? "; pin and update key still from HKLM" : "; HKLM has no key, so no pin and no update key"),
                };

                source = $"environment variable {ServerUrlEnvVar}";
                return Usable(overridden, ref source);
            }

            warning =
                $"⚠️ The environment variable {ServerUrlEnvVar} is set but ignored: this is a " +
                $"release build and {hklm}\\AllowServerUrlOverride is not 1.";
        }

        if (machine.Exists)
        {
            source = hklm;

            if (string.IsNullOrWhiteSpace(machine.ServerUrl))
            {
                source = $"{hklm} (the key exists but has no ServerUrl)";
                return null;
            }

            var fromHklm = FromMachine(machine, machine.ServerUrl.Trim(), allowHttp) with { LoadWarning = warning };
            return Usable(fromHklm, ref source);
        }

        var (file, path) = fromFile();
        source = path;
        if (file is null) return null;

        // Careful: whatever the file says, it never grants plain http (the property is
        // JsonIgnore'd anyway); only HKLM or a Debug build can.
        return Usable(file with { AllowInsecureHttp = debugBuild, LoadWarning = warning }, ref source);
    }

    private static AgentSettings FromMachine(MachineConfig machine, string serverUrl, bool allowHttp) => new()
    {
        ServerUrl = serverUrl,
        StaffPortalUrl = machine.StaffPortalUrl,
        PolicyUrl = machine.PolicyUrl,
        EnrollmentCode = machine.EnrollmentCode,
        ServerPin = machine.ServerPin,
        UpdatePublicKey = machine.UpdatePublicKey,
        AllowInsecureHttp = allowHttp,
    };

    /// <summary>The settings if their address is acceptable; otherwise <c>null</c>, and
    /// <paramref name="source"/> says why, so the "could not start" box names the cause.</summary>
    private static AgentSettings? Usable(AgentSettings settings, ref string source)
    {
        if (settings.IsUsable) return settings;

        source += Uri.TryCreate(settings.ServerUrl, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttp
            ? $" (ServerUrl {settings.ServerUrl} is plain http to another machine: the password and " +
              "device token would travel unencrypted. Use https, or have an administrator install " +
              "with ALLOWHTTP=1)"
            : $" (ServerUrl \"{settings.ServerUrl}\" is not a valid https:// address)";
        return null;
    }

    private static (AgentSettings?, string) FromFile(string directory)
    {
        var path = Path.Combine(directory, FileName);

        try
        {
            if (!File.Exists(path)) return (null, path);

            return (JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(path), Json), path);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return (null, $"{path} ({e.Message})");
        }
    }

    /// <summary>
    /// Careful: <c>Registry.LocalMachine</c> is opened <b>forcibly in the 64-bit view</b>. If the
    /// agent ran as 32-bit (or someone makes it AnyCPU in the future), Windows would silently
    /// redirect to <c>WOW6432Node</c>, where the MSI wrote nothing, and the agent would sit saying
    /// "not configured" although the install was fine.
    /// </summary>
    private static MachineConfig ReadMachineConfig()
    {
        try
        {
            using var root = RegistryKey64();
            using var key = root.OpenSubKey(RegistryKey);
            if (key is null) return MachineConfig.Absent;

            return new MachineConfig
            {
                ServerUrl = Trimmed(key, "ServerUrl"),
                StaffPortalUrl = Trimmed(key, "StaffPortalUrl"),
                PolicyUrl = Trimmed(key, "PolicyUrl"),
                EnrollmentCode = Trimmed(key, "EnrollmentCode"),
                ServerPin = Trimmed(key, "ServerPin"),
                UpdatePublicKey = Trimmed(key, "UpdatePublicKey"),
                AllowInsecureHttp = IsOn(key.GetValue("AllowInsecureHttp")),
                AllowServerUrlOverride = IsOn(key.GetValue("AllowServerUrlOverride")),
            };
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return new MachineConfig { ReadError = e.Message };
        }
    }

    /// <summary>
    /// A registry switch: DWORD 1, or the string "1" / "true" / "yes" (the MSI writes
    /// <c>Type="string"</c>, so an unset property arrives as an empty string = off).
    /// </summary>
    internal static bool IsOn(object? value) => value switch
    {
        int i => i == 1,
        long l => l == 1,
        string s => s.Trim() is "1" || s.Trim().Equals("true", StringComparison.OrdinalIgnoreCase)
                                    || s.Trim().Equals("yes", StringComparison.OrdinalIgnoreCase),
        _ => false,
    };

    private static Microsoft.Win32.RegistryKey RegistryKey64() =>
        Microsoft.Win32.RegistryKey.OpenBaseKey(
            Microsoft.Win32.RegistryHive.LocalMachine,
            Microsoft.Win32.RegistryView.Registry64);

    private static string? Trimmed(Microsoft.Win32.RegistryKey key, string name)
    {
        var value = (key.GetValue(name) as string)?.Trim();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
