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

    [JsonIgnore]
    public bool IsUsable => Uri.TryCreate(ServerUrl, UriKind.Absolute, out var u)
                            && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp);

    /// <summary>File name: in the data folder, next to the token.</summary>
    public const string FileName = "agent.json";

    /// <summary>
    /// Careful: the only way to run without the file during development. This environment variable
    /// does not exist in production, so there is no risk of data going to a different server from
    /// someone's machine by mistake.
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
    /// It looks in three places, in this order:
    /// <list type="number">
    /// <item>environment variable: development only</item>
    /// <item>registry <c>HKLM\SOFTWARE\oXeio\Agent</c>: where the MSI writes</item>
    /// <item><c>agent.json</c>: the manual route</item>
    /// </list>
    /// </summary>
    public static AgentSettings? Load(string? directory, out string source)
    {
        var env = Environment.GetEnvironmentVariable(ServerUrlEnvVar);
        if (!string.IsNullOrWhiteSpace(env))
        {
            source = $"environment variable {ServerUrlEnvVar}";
            return new AgentSettings { ServerUrl = env.Trim() };
        }

        var fromRegistry = FromRegistry();
        if (fromRegistry is not null)
        {
            source = $@"HKLM\{RegistryKey}";
            return fromRegistry;
        }

        var dir = directory ?? AgentDataDirectory.Default;
        var path = Path.Combine(dir, FileName);
        source = path;

        try
        {
            if (!File.Exists(path)) return null;

            var settings = JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(path), Json);
            return settings?.IsUsable == true ? settings : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Careful: <c>Registry.LocalMachine</c> is opened <b>forcibly in the 64-bit view</b>. If the
    /// agent ran as 32-bit (or someone makes it AnyCPU in the future), Windows would silently
    /// redirect to <c>WOW6432Node</c>, where the MSI wrote nothing, and the agent would sit saying
    /// "not configured" although the install was fine.
    /// </summary>
    private static AgentSettings? FromRegistry()
    {
        try
        {
            using var root = RegistryKey64();
            using var key = root.OpenSubKey(RegistryKey);
            if (key is null) return null;

            var url = key.GetValue("ServerUrl") as string;
            if (string.IsNullOrWhiteSpace(url)) return null;

            var settings = new AgentSettings
            {
                ServerUrl = url.Trim(),
                StaffPortalUrl = Trimmed(key, "StaffPortalUrl"),
                PolicyUrl = Trimmed(key, "PolicyUrl"),
                EnrollmentCode = Trimmed(key, "EnrollmentCode"),
                ServerPin = Trimmed(key, "ServerPin"),
                UpdatePublicKey = Trimmed(key, "UpdatePublicKey"),
            };

            return settings.IsUsable ? settings : null;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }

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
