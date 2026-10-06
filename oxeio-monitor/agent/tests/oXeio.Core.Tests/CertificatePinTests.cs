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
    public void With_no_pin_validation_is_left_to_the_OS() =>
        Assert.Equal(
            CertificatePin.Verdict.NoPinConfigured,
            CertificatePin.Check([], PinA, chainOk: true));

    [Fact]
    public void A_matching_pin_with_a_valid_chain_is_trusted() =>
        Assert.Equal(
            CertificatePin.Verdict.Trusted,
            CertificatePin.Check(Pins(PinA), PinA, chainOk: true));

    [Fact]
    public void A_pin_mismatch_is_rejected() =>
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
    public void A_matching_pin_with_a_broken_chain_is_still_rejected() =>
        Assert.Equal(
            CertificatePin.Verdict.ChainInvalid,
            CertificatePin.Check(Pins(PinA), PinA, chainOk: false));

    [Fact]
    public void No_certificate_is_rejected() =>
        Assert.Equal(
            CertificatePin.Verdict.NoCertificate,
            CertificatePin.Check(Pins(PinA), null, chainOk: true));

    /**
     * Careful: on certificate renewal day both the old and the new pin must stay valid
     * for a while. With a single pin, 15 agents would lose their connection at the same
     * moment of renewal (which is why the runbook § 7.1 has its particular order).
     */
    [Fact]
    public void Either_of_two_pins_matching_is_enough()
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
    public void The_comparison_is_case_sensitive() =>
        Assert.Equal(
            CertificatePin.Verdict.PinMismatch,
            CertificatePin.Check(Pins(PinA), PinA.ToLowerInvariant(), chainOk: true));

    // ── Parse ───────────────────────────────────────────────────────────────

    [Fact]
    public void An_empty_config_has_no_pins()
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
    public void Whitespace_and_extra_commas_are_filtered_out()
    {
        var pins = CertificatePin.Parse($" {PinA} , {PinB} , ");

        Assert.Equal(2, pins.Count);
        Assert.Equal(PinA, pins[0]);
        Assert.Equal(PinB, pins[1]);
    }

    [Fact]
    public void A_single_pin_works_too() =>
        Assert.Single(CertificatePin.Parse(PinA));

    /** Every state must have a sentence a human can read */
    [Theory]
    [InlineData(CertificatePin.Verdict.Trusted)]
    [InlineData(CertificatePin.Verdict.PinMismatch)]
    [InlineData(CertificatePin.Verdict.ChainInvalid)]
    [InlineData(CertificatePin.Verdict.NoCertificate)]
    [InlineData(CertificatePin.Verdict.NoPinConfigured)]
    public void Every_verdict_has_an_explanation(CertificatePin.Verdict verdict) =>
        Assert.False(string.IsNullOrWhiteSpace(CertificatePin.Explain(verdict)));
}
