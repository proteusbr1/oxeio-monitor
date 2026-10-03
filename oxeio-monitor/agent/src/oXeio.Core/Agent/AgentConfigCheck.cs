namespace oXeio.Core.Agent;

/// <summary>
/// Is a config from the server safe to apply — and to keep on disk?
///
/// ⚠️ This is a sanity check, not the policy rules. The bounds are the server's
/// own DTO limits (<c>server/src/admin/dto.ts</c>), so anything the dashboard
/// can save passes; only a damaged or impossible config is refused. Refusing a
/// legitimate one would be worse than the bug this guards against: the agent
/// would stay on an old policy while the dashboard shows the new one.
///
/// Why it matters now: a refused config is not applied and not cached, so a
/// broken answer can never replace the last good config on disk.
/// </summary>
public static class AgentConfigCheck
{
    /// <summary>Empty when the config is usable; otherwise one line per problem.</summary>
    public static IReadOnlyList<string> Problems(AgentConfig? cfg)
    {
        if (cfg is null) return ["config is missing"];

        var problems = new List<string>();

        // server: @Min(10) @Max(3600)
        if (cfg.IdleThresholdSec is < 10 or > 3600)
            problems.Add($"idleThresholdSec {cfg.IdleThresholdSec} outside 10–3600");

        // server: @Min(1) @Max(60)
        if (cfg.SlotMinutes is < 1 or > 60)
            problems.Add($"slotMinutes {cfg.SlotMinutes} outside 1–60");

        // server: @Min(1) @Max(744) — 744 = 31 × 24
        if (double.IsNaN(cfg.MonthlyTargetHours) || cfg.MonthlyTargetHours is < 1 or > 744)
            problems.Add($"monthlyTargetHours {cfg.MonthlyTargetHours} outside 1–744");

        // the server sends a constant 30; anything non-positive would spin the loop
        if (cfg.HeartbeatSec is < 1 or > 3600)
            problems.Add($"heartbeatSec {cfg.HeartbeatSec} outside 1–3600");

        // null means "no limit" (ADR-011c); a value that does not parse is damage
        if (cfg.ScreenshotFrom is not null && AgentConfig.ParseHhMm(cfg.ScreenshotFrom) is null)
            problems.Add($"screenshotFrom '{cfg.ScreenshotFrom}' is not HH:MM");
        if (cfg.ScreenshotTo is not null && AgentConfig.ParseHhMm(cfg.ScreenshotTo) is null)
            problems.Add($"screenshotTo '{cfg.ScreenshotTo}' is not HH:MM");

        if (string.IsNullOrWhiteSpace(cfg.Timezone))
            problems.Add("timezone is empty");

        if (cfg.AppTracking is null)
            problems.Add("appTracking is missing");
        else if (cfg.AppTracking.MinDurationSec < 0)
            problems.Add($"appTracking.minDurationSec {cfg.AppTracking.MinDurationSec} is negative");

        if (cfg.Screenshot is null)
            problems.Add("screenshot is missing");
        else
        {
            if (cfg.Screenshot.Quality is < 1 or > 100)
                problems.Add($"screenshot.quality {cfg.Screenshot.Quality} outside 1–100");
            if (cfg.Screenshot.MaxWidth < 1)
                problems.Add($"screenshot.maxWidth {cfg.Screenshot.MaxWidth} is not positive");
        }

        return problems;
    }

    public static bool IsUsable(AgentConfig? cfg) => Problems(cfg).Count == 0;
}
