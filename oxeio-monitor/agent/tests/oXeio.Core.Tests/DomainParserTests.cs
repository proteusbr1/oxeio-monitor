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
    public void ডোমেইনটুকুই_বেরোয়(string url, string expected)
    {
        Assert.Equal(expected, DomainParser.Extract(url));
    }

    /// <summary>
    /// This is the most important test. A full URL holds tokens, account numbers,
    /// search terms, everything. Once it lands in the database there is no way back.
    /// </summary>
    [Fact]
    public void পথ_query_কিছুই_বেরোয়_না()
    {
        var d = DomainParser.Extract("https://bank.com/account/12345?token=SECRET#tab");

        Assert.Equal("bank.com", d);
        Assert.DoesNotContain("12345", d);
        Assert.DoesNotContain("SECRET", d);
    }

    [Fact]
    public void URL_এ_ইউজারনেম_পাসওয়ার্ড_থাকলেও_যায়_না()
    {
        Assert.Equal("intranet.local", DomainParser.Extract("https://admin:hunter2@intranet.local/x"));
    }

    [Fact]
    public void IPv6_ঠিকানা_কেটে_যায়_না()
    {
        // several ':' present, so the port trimming does not apply
        Assert.Equal("[::1]", DomainParser.Extract("http://[::1]/dashboard"));
    }

    /// <summary>
    /// People search in the address bar too. If those were stored as a "domain", the
    /// server would effectively get a search history, which is just another form of keylogging.
    /// </summary>
    [Theory]
    [InlineData("কীভাবে excel pivot table বানায়")]
    [InlineData("best laptop 2026")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("notadomain")]
    public void সার্চ_শব্দ_ডোমেইন_হিসেবে_যায়_না(string typed)
    {
        Assert.Null(DomainParser.Extract(typed));
    }

    [Fact]
    public void localhost_চলে()
    {
        Assert.Equal("localhost", DomainParser.Extract("http://localhost:3000/api"));
    }

    [Fact]
    public void null_দিলে_null()
    {
        Assert.Null(DomainParser.Extract(null));
    }

    // ── private browsing ────────────────────────────────────────────────────

    [Theory]
    [InlineData("YouTube - Google Chrome (Incognito)")]
    [InlineData("Bing - Microsoft​ Edge [InPrivate]")]
    [InlineData("Mozilla Firefox (Private Browsing)")]
    [InlineData("ছদ্মবেশী উইন্ডো — Chrome")]
    public void ব্যক্তিগত_উইন্ডো_চেনা_যায়(string title)
    {
        Assert.True(DomainParser.LooksPrivate(title));
    }

    [Theory]
    [InlineData("YouTube - Google Chrome")]
    [InlineData("Inbox (23) - Outlook")]
    [InlineData(null)]
    public void সাধারণ_উইন্ডো_ব্যক্তিগত_নয়(string? title)
    {
        Assert.False(DomainParser.LooksPrivate(title));
    }
}
