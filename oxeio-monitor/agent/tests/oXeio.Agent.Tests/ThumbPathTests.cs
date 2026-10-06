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
    public void The_thumbnail_sits_next_to_the_main_image()
    {
        var main = @"C:\ProgramData\oXeio\queue\2026-08-11\140500-m0-abc.webp";

        Assert.Equal(
            @"C:\ProgramData\oXeio\queue\2026-08-11\140500-m0-abc-thumb.webp",
            OutboxPaths.ThumbPathFor(main));
    }

    /// <summary>Careful: it must still end in .webp; the sweeper looks for `*.webp`.</summary>
    [Fact]
    public void The_thumbnail_stays_a_webp_file() =>
        Assert.EndsWith(".webp", OutboxPaths.ThumbPathFor("x/y.webp"));

    /// <summary>Calling it twice must not turn into `-thumb-thumb`.</summary>
    [Fact]
    public void Applying_it_to_its_own_result_gives_a_different_path()
    {
        var once = OutboxPaths.ThumbPathFor("a.webp");

        Assert.NotEqual(once, OutboxPaths.ThumbPathFor(once));
    }
}
