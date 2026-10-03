using System.Security.Cryptography;

namespace oXeio.Core.Agent;

/// <summary>What became of an update's signature check.</summary>
public enum SignatureCheck
{
    /// <summary>No update key on this PC — only the sha256 is checked, as before.</summary>
    NotRequired,

    Valid,

    /// <summary>The PC has a key, the server sent no signature.</summary>
    Missing,

    /// <summary>The signature does not match this MSI and this key.</summary>
    Invalid,
}

/// <summary>
/// The second check on a downloaded update: was this MSI signed by the
/// owner's key, not only described by the server?
///
/// ⚠️ Why the sha256 is not enough: it comes from the same server as the MSI.
///    It catches a broken download, but whoever controls the server can hand
///    out a different MSI with its matching hash — and an update runs as
///    administrator on every PC. A signature made with a key that never sits
///    on the server closes that: the server can pass a signature on, it cannot
///    make one.
///
/// ⭐ ECDSA P-256 over the MSI's SHA-256 — built into .NET 8 and Node and made
///    with plain OpenSSL (`openssl dgst -sha256 -sign key.pem -out x.msi.sig
///    x.msi`), so no extra library ships with the agent.
///
/// ⚠️ Off unless the PC has a public key (registry `UpdatePublicKey`, MSI
///    property UPDATEKEY). Then a missing signature is refused as firmly as
///    a wrong one — otherwise an attacker would simply send none.
/// </summary>
public static class UpdateSignature
{
    /// <summary>
    /// The public key as written by the installer: a PEM block, or just its
    /// base64 body (SubjectPublicKeyInfo) on one line — an MSI property cannot
    /// hold line breaks. <c>null</c> when there is no key or it cannot be read.
    /// </summary>
    public static ECDsa? ParsePublicKey(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var body = OneLine(text);

        try
        {
            var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(body), out _);
            return key;
        }
        catch (Exception e) when (e is FormatException or CryptographicException)
        {
            return null;
        }
    }

    /// <summary>
    /// The key as one line of base64 — what an MSI property and a command line
    /// can carry. PEM headers and line breaks are dropped.
    /// </summary>
    public static string OneLine(string text) =>
        string.Concat(text
            .Replace("-----BEGIN PUBLIC KEY-----", "", StringComparison.Ordinal)
            .Replace("-----END PUBLIC KEY-----", "", StringComparison.Ordinal)
            .Where(c => !char.IsWhiteSpace(c)));

    /// <param name="key">from <see cref="ParsePublicKey"/>; <c>null</c> = not required</param>
    /// <param name="sha256Hex">the MSI's SHA-256, already compared with the offer</param>
    /// <param name="signatureBase64">the DER signature from the offer</param>
    public static SignatureCheck Verify(ECDsa? key, string sha256Hex, string? signatureBase64)
    {
        if (key is null) return SignatureCheck.NotRequired;
        if (string.IsNullOrWhiteSpace(signatureBase64)) return SignatureCheck.Missing;

        try
        {
            var hash = Convert.FromHexString(sha256Hex);
            var signature = Convert.FromBase64String(signatureBase64.Trim());
            return hash.Length == 32 &&
                   key.VerifyHash(hash, signature, DSASignatureFormat.Rfc3279DerSequence)
                ? SignatureCheck.Valid
                : SignatureCheck.Invalid;
        }
        catch (Exception e) when (e is FormatException or CryptographicException)
        {
            return SignatureCheck.Invalid;
        }
    }
}
