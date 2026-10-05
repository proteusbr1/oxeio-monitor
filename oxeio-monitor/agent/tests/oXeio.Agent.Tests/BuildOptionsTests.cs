namespace oXeio.Agent.Tests;

/// <summary>
/// build.ps1 -HideLatestShot builds an agent without the screenshot preview.
/// The tests run against the normal build, so it must keep the preview —
/// a default that changed by accident would hide it on every PC.
/// </summary>
public class BuildOptionsTests
{
    [Fact]
    public void The_normal_build_shows_the_latest_screenshot()
    {
        Assert.True(BuildOptions.ShowLatestShot);
    }

    [Fact]
    public void The_project_knows_the_HideLatestShot_switch()
    {
        // the switch build.ps1 passes must exist in the project, or
        // -HideLatestShot would silently build the normal agent
        var csproj = File.ReadAllText(FindProject());
        Assert.Contains("'$(HideLatestShot)' == 'true'", csproj);
        Assert.Contains("HIDE_LATEST_SHOT", csproj);
    }

    private static string FindProject()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, "src", "oXeio.Agent", "oXeio.Agent.csproj");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }
        throw new FileNotFoundException("oXeio.Agent.csproj not found above the test output");
    }
}
