using oXeio.Core.Apps;

namespace oXeio.Core.Tests;

public class DomainParserTests
{
    [Theory]
    [InlineData("https://youtube.com/watch?v=abc", "youtube.com")]
    [InlineData("http://facebook.com", "facebook.com")]
    [InlineData("github.com/anthropics/claude", "github.com")]
    [InlineData("https://Mail.Google.COM/inbox", "mail.google.com")]
    [InlineData("https://docs.google.com:443/document/d/xyz", "docs.google.com")]
    public void Only_the_domain_comes_out(string url, string expected)
    {
        Assert.Equal(expected, DomainParser.Extract(url));
    }

    /// <summary>
    /// This is the most important test. A full URL holds tokens, account numbers,
    /// search terms, everything. Once it lands in the database there is no way back.
    /// </summary>
    [Fact]
    public void Path_query_and_fragment_never_come_out()
    {
        var d = DomainParser.Extract("https://bank.com/account/12345?token=SECRET#tab");

        Assert.Equal("bank.com", d);
        Assert.DoesNotContain("12345", d);
        Assert.DoesNotContain("SECRET", d);
    }

    [Fact]
    public void Username_and_password_in_the_URL_do_not_leak()
    {
        Assert.Equal("intranet.local", DomainParser.Extract("https://admin:hunter2@intranet.local/x"));
    }

    [Fact]
    public void An_IPv6_address_is_not_truncated()
    {
        // several ':' present, so the port trimming does not apply
        Assert.Equal("[::1]", DomainParser.Extract("http://[::1]/dashboard"));
    }

    /// <summary>
    /// People search in the address bar too. If those were stored as a "domain", the
    /// server would effectively get a search history, which is just another form of keylogging.
    /// </summary>
    [Theory]
    [InlineData("エクセル pivot table の作り方")]
    [InlineData("best laptop 2026")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("notadomain")]
    public void Search_terms_are_not_returned_as_a_domain(string typed)
    {
        Assert.Null(DomainParser.Extract(typed));
    }

    [Fact]
    public void Localhost_is_accepted()
    {
        Assert.Equal("localhost", DomainParser.Extract("http://localhost:3000/api"));
    }

    [Fact]
    public void Null_input_gives_null()
    {
        Assert.Null(DomainParser.Extract(null));
    }

    // ── private browsing ────────────────────────────────────────────────────

    [Theory]
    [InlineData("YouTube - Google Chrome (Incognito)")]
    [InlineData("Bing - Microsoft​ Edge [InPrivate]")]
    [InlineData("Mozilla Firefox (Private Browsing)")]
    [InlineData("ছদ্মবেশী উইন্ডো — Chrome")]
    public void Private_windows_are_recognised(string title)
    {
        Assert.True(DomainParser.LooksPrivate(title));
    }

    [Theory]
    [InlineData("YouTube - Google Chrome")]
    [InlineData("Inbox (23) - Outlook")]
    [InlineData(null)]
    public void Normal_windows_are_not_private(string? title)
    {
        Assert.False(DomainParser.LooksPrivate(title));
    }
}
