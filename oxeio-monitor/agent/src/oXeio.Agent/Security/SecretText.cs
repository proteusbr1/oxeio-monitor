using System.Security.Cryptography;
using System.Text;

namespace oXeio.Agent.Security;

/// <summary>
/// A secret string (device token, enrollment code) that never goes into a log.
///
/// <b>Why a separate type instead of a plain string:</b> the real way a token leaks is a
/// careless <c>$"..."</c>. The process runs for weeks and log files stay on disk for about
/// a month; a single <c>Line($"enroll ok: {response}")</c> would leave the payroll server's
/// token in plain text and nobody would ever notice. <see cref="ToString"/> is overridden
/// here, so even that line prints nothing but «secret:a1b2c3d4».
///
/// Careful: do not make this a <c>record</c>. The compiler-generated <c>ToString</c> of a
/// record prints every public member, which brings back exactly what we are preventing. For
/// the same reason the inner value is not exposed as a public property; you have to call
/// <see cref="Reveal"/>, and that can be found with grep.
///
/// Careful: <b>what this cannot do:</b> in .NET a <c>string</c> is immutable and the GC moves
/// it, so wiping the value from memory is <b>impossible</b>. A full crash dump would contain
/// the token, so <c>DOTNET_DbgEnableMiniDump</c> must not be enabled in deployments. This
/// class prevents log leaks, not memory forensics; that is all it claims.
/// </summary>
internal sealed class SecretText
{
    private readonly string _value;

    public SecretText(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        _value = value;
        Fingerprint = ComputeFingerprint(value);
    }

    /// A safe identity for logging: the first 8 hex characters of the sha256.
    /// <summary>
    /// A safe identity for logging: the first 8 hex characters of the sha256.
    /// With it, "did the token change?" or "is it the same token on two machines?" can be
    /// answered from the log alone, without writing the token. A 32-bit hash of a random
    /// 32-byte token does not let anyone recover the token.
    /// </summary>
    public string Fingerprint { get; }

    public int Length => _value.Length;

    /// <summary>
    /// The real value. Careful: only right before sending over the network or encrypting
    /// to disk.
    ///
    /// There are exactly <b>four</b> call sites in the whole agent, and grepping for
    /// <c>Reveal(</c> finds all of them. For an audit this is the complete list:
    /// <list type="number">
    /// <item><see cref="DeviceCredentials.ApplyTo"/>: token into the sync client.</item>
    /// <item><c>DeviceCredentials.IDeviceTokenSource.CurrentToken</c>: same job, pull style.</item>
    /// <item><c>DeviceTokenStore.Serialize</c>: just before DPAPI.</item>
    /// <item><c>EnrollmentClient.EnrollAsync</c>: enrollment code into the request body.</item>
    /// </list>
    /// Think twice before adding a new call site, and update this list too.
    /// </summary>
    public string Reveal() => _value;

    /// <summary>Empty or whitespace only; used to reject before sending to the server.</summary>
    public bool IsBlank => string.IsNullOrWhiteSpace(_value);

    public override string ToString() => $"«secret:{Fingerprint}»";

    /// <summary>
    /// Careful: not constant-time, and that is fine. The token is not being verified here;
    /// this only checks whether the one on disk equals the one in memory. There is no
    /// timing-attack adversary.
    /// </summary>
    public bool SameAs(SecretText? other) =>
        other is not null && string.Equals(_value, other._value, StringComparison.Ordinal);

    private static string ComputeFingerprint(string value)
    {
        // Encoding.UTF8 on purpose: with Encoding.Default the same token's fingerprint would
        // change per code page and raise false "token changed" alarms.
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash, 0, 4).ToLowerInvariant();
    }
}
