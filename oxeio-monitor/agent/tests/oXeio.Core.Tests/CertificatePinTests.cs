using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

/// <summary>
/// **I01**: the certificate pinning decision.
///
/// Careful: half the tests in this file guard against one mistake: <b>answering
/// `true` just because the pin matched</b>. In .NET, installing the callback turns
/// off all of .NET's own validation (hostname, expiry, chain). If we accepted whenever
/// the pin matched, those checks would silently vanish and nobody would ever notice,
/// because the connection would still work.
/// </summary>
public class CertificatePinTests
{
    private const string PinA = "aGFzaC1vZi1zZXJ2ZXItYQ==";
    private const string PinB = "aGFzaC1vZi1zZXJ2ZXItYg==";

    private static string[] Pins(params string[] pins) => pins;

    [Fact]
    public void পিন_না_থাকলে_যাচাই_ওএসের_হাতে() =>
        Assert.Equal(
            CertificatePin.Verdict.NoPinConfigured,
            CertificatePin.Check([], PinA, chainOk: true));

    [Fact]
    public void পিন_মিললে_আর_চেইন_ঠিক_থাকলে_চলে() =>
        Assert.Equal(
            CertificatePin.Verdict.Trusted,
            CertificatePin.Check(Pins(PinA), PinA, chainOk: true));

    [Fact]
    public void পিন_না_মিললে_প্রত্যাখ্যান() =>
        Assert.Equal(
            CertificatePin.Verdict.PinMismatch,
            CertificatePin.Check(Pins(PinA), PinB, chainOk: true));

    /**
     * The most important test in this file. The pin matches, yet the answer is **no**,
     * because the hostname does not match, or the cert has expired, or the chain is
     * broken. Once the callback is installed .NET no longer checks these on its own;
     * without that check an expired certificate would work forever.
     */
    [Fact]
    public void পিন_মিললেও_চেইন_ভাঙা_থাকলে_প্রত্যাখ্যান() =>
        Assert.Equal(
            CertificatePin.Verdict.ChainInvalid,
            CertificatePin.Check(Pins(PinA), PinA, chainOk: false));

    [Fact]
    public void সার্টই_না_এলে_প্রত্যাখ্যান() =>
        Assert.Equal(
            CertificatePin.Verdict.NoCertificate,
            CertificatePin.Check(Pins(PinA), null, chainOk: true));

    /**
     * Careful: on certificate renewal day both the old and the new pin must stay valid
     * for a while. With a single pin, 15 agents would lose their connection at the same
     * moment of renewal (which is why the runbook § 7.1 has its particular order).
     */
    [Fact]
    public void দুটো_পিনের_যেকোনো_একটা_মিললেই_চলে()
    {
        Assert.Equal(
            CertificatePin.Verdict.Trusted,
            CertificatePin.Check(Pins(PinA, PinB), PinB, chainOk: true));

        Assert.Equal(
            CertificatePin.Verdict.Trusted,
            CertificatePin.Check(Pins(PinA, PinB), PinA, chainOk: true));
    }

    /** Careful: base64 is case-sensitive; a one-character difference is a different key */
    [Fact]
    public void তুলনাটা_অক্ষরের_ছাঁদ_মেনে_চলে() =>
        Assert.Equal(
            CertificatePin.Verdict.PinMismatch,
            CertificatePin.Check(Pins(PinA), PinA.ToLowerInvariant(), chainOk: true));

    // ── Parse ───────────────────────────────────────────────────────────────

    [Fact]
    public void খালি_কনফিগে_কোনো_পিন_নেই()
    {
        Assert.Empty(CertificatePin.Parse(null));
        Assert.Empty(CertificatePin.Parse(""));
        Assert.Empty(CertificatePin.Parse("   "));
    }

    /**
     * Careful: values typed by hand into the registry often arrive with a trailing
     * comma or extra whitespace. If not filtered, an **empty string** would enter as
     * a pin: it would never match anything, but it would keep the list "non-empty",
     * so pinning would be on and always failing.
     */
    [Fact]
    public void ফাঁকা_জায়গা_ও_বাড়তি_কমা_ছেঁকে_নেয()
    {
        var pins = CertificatePin.Parse($" {PinA} , {PinB} , ");

        Assert.Equal(2, pins.Count);
        Assert.Equal(PinA, pins[0]);
        Assert.Equal(PinB, pins[1]);
    }

    [Fact]
    public void একটা_পিনও_চলে() =>
        Assert.Single(CertificatePin.Parse(PinA));

    /** Every state must have a sentence a human can read */
    [Theory]
    [InlineData(CertificatePin.Verdict.Trusted)]
    [InlineData(CertificatePin.Verdict.PinMismatch)]
    [InlineData(CertificatePin.Verdict.ChainInvalid)]
    [InlineData(CertificatePin.Verdict.NoCertificate)]
    [InlineData(CertificatePin.Verdict.NoPinConfigured)]
    public void প্রতিটা_অবস্থার_ব্যাখ্যা_আছে(CertificatePin.Verdict verdict) =>
        Assert.False(string.IsNullOrWhiteSpace(CertificatePin.Explain(verdict)));
}
