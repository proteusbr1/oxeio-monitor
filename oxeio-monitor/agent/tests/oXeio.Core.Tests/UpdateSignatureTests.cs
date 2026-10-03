using System.Security.Cryptography;

using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// The owner's signature on an update, checked on the PC. The OpenSSL case is
/// the important one: it is the command the owner actually runs
/// (deploy/README.md), so the agent must accept exactly that output.
/// </summary>
public class UpdateSignatureTests
{
    // made with:
    //   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
    //   openssl ec -in key.pem -pubout -out pub.pem
    //   openssl dgst -sha256 -sign key.pem -out a.msi.sig a.msi
    private const string OpenSslPublicKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6p7Rdo6T1C/cclg2fBYwTYfABYMu4ttpP79rlhGNLlR4d/Nln2TL0mwxvBO0tn+kbluTEpifo+YWfYwebm1vXQ==";
    private const string OpenSslSha256 =
        "6766f2352215472a37dcdbb4ccf62801e877fa90dec7b6d9afe675b1fd1432ae";
    private const string OpenSslSignature =
        "MEUCIQDpgh9xqO35yyvLdVjqGytZH7nX3qYZYWKuDuoNs+aLHwIgRMm6nHpsMuNhI7zwTyD2+a5bOXAR1k6lbbgLpXqLspc=";

    [Fact]
    public void No_key_on_the_PC_means_only_the_hash_is_checked_as_before()
    {
        Assert.Null(UpdateSignature.ParsePublicKey(null));
        Assert.Null(UpdateSignature.ParsePublicKey("  "));
        Assert.Equal(SignatureCheck.NotRequired, UpdateSignature.Verify(null, OpenSslSha256, null));
    }

    [Fact]
    public void Accepts_what_openssl_signs()
    {
        var key = UpdateSignature.ParsePublicKey(OpenSslPublicKey);
        Assert.Equal(SignatureCheck.Valid, UpdateSignature.Verify(key, OpenSslSha256, OpenSslSignature));
    }

    [Fact]
    public void Accepts_the_key_as_a_whole_PEM_block_too()
    {
        var pem = $"-----BEGIN PUBLIC KEY-----\n{OpenSslPublicKey[..40]}\n{OpenSslPublicKey[40..]}\n-----END PUBLIC KEY-----\n";
        var key = UpdateSignature.ParsePublicKey(pem);
        Assert.Equal(SignatureCheck.Valid, UpdateSignature.Verify(key, OpenSslSha256, OpenSslSignature));
    }

    [Fact]
    public void A_different_MSI_with_its_own_correct_hash_is_refused()
    {
        // the attack this exists for: the server sends another file and its hash
        var key = UpdateSignature.ParsePublicKey(OpenSslPublicKey);
        var otherHash = Convert.ToHexString(SHA256.HashData("malicious"u8.ToArray()));
        Assert.Equal(SignatureCheck.Invalid, UpdateSignature.Verify(key, otherHash, OpenSslSignature));
    }

    [Fact]
    public void A_missing_signature_is_refused_when_the_PC_has_a_key()
    {
        var key = UpdateSignature.ParsePublicKey(OpenSslPublicKey);
        Assert.Equal(SignatureCheck.Missing, UpdateSignature.Verify(key, OpenSslSha256, null));
        Assert.Equal(SignatureCheck.Missing, UpdateSignature.Verify(key, OpenSslSha256, " "));
    }

    [Fact]
    public void A_signature_by_another_key_is_refused()
    {
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var hash = Convert.FromHexString(OpenSslSha256);
        var foreign = Convert.ToBase64String(
            other.SignHash(hash, DSASignatureFormat.Rfc3279DerSequence));

        var key = UpdateSignature.ParsePublicKey(OpenSslPublicKey);
        Assert.Equal(SignatureCheck.Invalid, UpdateSignature.Verify(key, OpenSslSha256, foreign));
    }

    [Theory]
    [InlineData("not base64!")]
    [InlineData("AAAA")]
    public void Garbage_is_invalid_not_an_exception(string signature)
    {
        var key = UpdateSignature.ParsePublicKey(OpenSslPublicKey);
        Assert.Equal(SignatureCheck.Invalid, UpdateSignature.Verify(key, OpenSslSha256, signature));
    }

    [Fact]
    public void An_unreadable_key_is_no_key()
    {
        Assert.Null(UpdateSignature.ParsePublicKey("definitely not a key"));
    }
}
