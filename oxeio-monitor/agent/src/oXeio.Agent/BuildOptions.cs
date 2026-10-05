namespace oXeio.Agent;

/// <summary>
/// Choices fixed when the agent is built, not configured on the PC — so
/// nobody at the PC can switch them back.
/// </summary>
internal static class BuildOptions
{
    /// <summary>
    /// Whether the Today window shows a preview of the last screenshot.
    /// <c>false</c> in a build made with <c>build.ps1 -HideLatestShot</c>
    /// (<c>-p:HideLatestShot=true</c>): the window still says <i>when</i> the
    /// last picture was taken, but shows no picture, and no copy of it is kept
    /// on the PC. Pictures are still taken and sent exactly as before.
    /// </summary>
#if HIDE_LATEST_SHOT
    public static readonly bool ShowLatestShot = false;
#else
    public static readonly bool ShowLatestShot = true;
#endif
}
