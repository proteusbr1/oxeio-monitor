using oXeio.Agent.Storage;

namespace oXeio.Agent.Tests;

/// <summary>
/// A06: the thumbnail path.
///
/// Four separate places follow this rule: write, send, delete, orphan sweep. If any
/// one differs, either the thumbnail never gets sent, or the sweeper takes every
/// thumbnail for an orphan and <b>deletes it</b>, and nobody would understand why the
/// gallery suddenly became slow again.
/// </summary>
public class ThumbPathTests
{
    [Fact]
    public void মূল_ছবির_পাশেই_থাকে()
    {
        var main = @"C:\ProgramData\oXeio\queue\2026-08-11\140500-m0-abc.webp";

        Assert.Equal(
            @"C:\ProgramData\oXeio\queue\2026-08-11\140500-m0-abc-thumb.webp",
            OutboxPaths.ThumbPathFor(main));
    }

    /// <summary>Careful: it must still end in .webp; the sweeper looks for `*.webp`.</summary>
    [Fact]
    public void থাম্বনেইলও_webp_থাকে() =>
        Assert.EndsWith(".webp", OutboxPaths.ThumbPathFor("x/y.webp"));

    /// <summary>Calling it twice must not turn into `-thumb-thumb`.</summary>
    [Fact]
    public void নিজের_উপর_আবার_চালালে_আলাদা_পথ()
    {
        var once = OutboxPaths.ThumbPathFor("a.webp");

        Assert.NotEqual(once, OutboxPaths.ThumbPathFor(once));
    }
}
