using oXeio.Core.Agent;

namespace oXeio.Core.Tests;

public class OutboxBudgetTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);

    /// <summary>Cap 1000, target 600, 7 days / 30 days for segments.</summary>
    private static OutboxBudget Small() =>
        new(1000, 600, TimeSpan.FromDays(7), TimeSpan.FromDays(30));

    private static OutboxEntryInfo Entry(
        long id, OutboundKind kind, long bytes, double ageDays = 0, bool leased = false) =>
        new(id, kind, Now - TimeSpan.FromDays(ageDays), bytes, leased);

    // ── when there is nothing to do ─────────────────────────────────────────

    [Fact]
    public void An_empty_outbox_needs_no_action()
    {
        var plan = Small().Plan([], Now);

        Assert.True(plan.IsEmpty);
        Assert.Equal(0L, plan.BytesBefore);
    }

    [Fact]
    public void Under_the_cap_nothing_is_dropped()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 400),
            Entry(2, OutboundKind.Segment, 100),
        ];

        var plan = Small().Plan(entries, Now);

        Assert.True(plan.IsEmpty);
        Assert.Equal(500L, plan.BytesBefore);
        Assert.Equal(500L, plan.BytesAfter);
    }

    // ── what goes first ─────────────────────────────────────────────────────

    /// <summary>
    /// One screenshot takes about as much room as a thousand segments. There is no
    /// reason to touch segments to free space.
    /// </summary>
    [Fact]
    public void Screenshots_go_first_when_space_is_needed()
    {
        var budget = new OutboxBudget(1000, 900, TimeSpan.FromDays(7), TimeSpan.FromDays(30));

        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Segment, 600),
            Entry(2, OutboundKind.Screenshot, 600),
        ];

        var plan = budget.Plan(entries, Now);

        Assert.Equal(new[] { 2L }, plan.OverBudgetRowIds);
        Assert.Empty(plan.ExpiredRowIds);
        Assert.Equal(600L, plan.BytesAfter);
    }

    [Fact]
    public void Drop_order_is_screenshot_then_app_usage_then_event_and_segment_last()
    {
        var budget = new OutboxBudget(10, 1, TimeSpan.FromDays(7), TimeSpan.FromDays(30));

        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Segment, 100),
            Entry(2, OutboundKind.Event, 100),
            Entry(3, OutboundKind.AppUsage, 100),
            Entry(4, OutboundKind.Screenshot, 100),
        ];

        var plan = budget.Plan(entries, Now);

        Assert.Equal(new[] { 4L, 3L, 2L, 1L }, plan.OverBudgetRowIds);
    }

    [Fact]
    public void Within_the_same_kind_the_oldest_goes_first()
    {
        var budget = new OutboxBudget(1000, 900, TimeSpan.FromDays(7), TimeSpan.FromDays(30));

        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 600, ageDays: 1),
            Entry(2, OutboundKind.Screenshot, 600, ageDays: 5),
        ];

        var plan = budget.Plan(entries, Now);

        Assert.Equal(new[] { 2L }, plan.OverBudgetRowIds); // the one 5 days old
    }

    /// <summary>
    /// As a last resort segments go too, but only when nothing else is left. The rule
    /// is not "segments are immortal", it is "segments go last".
    /// </summary>
    [Fact]
    public void Segments_go_too_when_nothing_else_is_left()
    {
        var budget = new OutboxBudget(100, 50, TimeSpan.FromDays(7), TimeSpan.FromDays(30));

        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Segment, 50, ageDays: 3),
            Entry(2, OutboundKind.Segment, 50, ageDays: 2),
            Entry(3, OutboundKind.Segment, 50, ageDays: 1),
        ];

        var plan = budget.Plan(entries, Now);

        Assert.Equal(new[] { 1L, 2L }, plan.OverBudgetRowIds);
        Assert.Equal(50L, plan.BytesAfter);
    }

    // ── hysteresis ──────────────────────────────────────────────────────────

    /// <summary>
    /// If trimming stopped exactly at the cap, every following screenshot would trigger
    /// another trim: one DELETE + fsync every 5 minutes, week after week.
    /// </summary>
    [Fact]
    public void Trimming_stops_as_soon_as_the_target_is_reached()
    {
        var entries = new List<OutboxEntryInfo>();
        for (var i = 1; i <= 10; i++)
            entries.Add(Entry(i, OutboundKind.Screenshot, 150, ageDays: (10 - i) * 0.5));

        var plan = Small().Plan(entries, Now); // total 1500, cap 1000, target 600

        Assert.Empty(plan.ExpiredRowIds);
        Assert.Equal(6, plan.OverBudgetRowIds.Count);
        Assert.Equal(600L, plan.BytesAfter);
    }

    // ── age ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Old_screenshots_expire_even_under_the_cap()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 10, ageDays: 8),
            Entry(2, OutboundKind.Screenshot, 10, ageDays: 6),
        ];

        var plan = Small().Plan(entries, Now);

        Assert.Equal(new[] { 1L }, plan.ExpiredRowIds);
        Assert.Empty(plan.OverBudgetRowIds);
    }

    /// <summary>
    /// Careful: this is the most valuable rule: a two-week line outage with a 7-day
    /// retention would delete the pay of a whole fortnight.
    /// </summary>
    [Fact]
    public void Segment_retention_is_separate_and_much_longer()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Segment, 10, ageDays: 8),
            Entry(2, OutboundKind.Screenshot, 10, ageDays: 8),
        ];

        var plan = Small().Plan(entries, Now);

        Assert.Equal(new[] { 2L }, plan.ExpiredRowIds); // only the screenshot
    }

    [Fact]
    public void Segments_expire_too_after_thirty_days()
    {
        OutboxEntryInfo[] entries = [Entry(1, OutboundKind.Segment, 10, ageDays: 31)];

        var plan = Small().Plan(entries, Now);

        Assert.Equal(new[] { 1L }, plan.ExpiredRowIds);
    }

    // ── borrowed rows ───────────────────────────────────────────────────────

    /// <summary>
    /// Borrowed means being uploaded right now. If the .webp were removed from under
    /// it, the upload would break midway and the row would be lost too.
    /// </summary>
    [Fact]
    public void Leased_rows_are_not_touched()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 900, ageDays: 20, leased: true),
            Entry(2, OutboundKind.Screenshot, 400, ageDays: 1),
        ];

        var plan = Small().Plan(entries, Now); // total 1300 > cap 1000

        Assert.DoesNotContain(1L, plan.RowIds);
        Assert.Equal(new[] { 2L }, plan.OverBudgetRowIds);
    }

    [Fact]
    public void With_every_row_leased_there_is_nothing_to_do()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 900, ageDays: 20, leased: true),
            Entry(2, OutboundKind.Screenshot, 900, ageDays: 20, leased: true),
        ];

        var plan = Small().Plan(entries, Now);

        Assert.True(plan.IsEmpty);
        Assert.Equal(1800L, plan.BytesAfter); // over the cap, yet this is the safe path
    }

    // ── arithmetic and validation ───────────────────────────────────────────

    [Fact]
    public void Age_and_cap_rules_apply_together()
    {
        OutboxEntryInfo[] entries =
        [
            Entry(1, OutboundKind.Screenshot, 700, ageDays: 8), // expired
            Entry(2, OutboundKind.Screenshot, 700, ageDays: 1),
            Entry(3, OutboundKind.Screenshot, 300, ageDays: 2),
            Entry(4, OutboundKind.Segment, 100),
        ];

        var plan = Small().Plan(entries, Now);

        Assert.Equal(1800L, plan.BytesBefore);
        Assert.Equal(new[] { 1L }, plan.ExpiredRowIds);
        Assert.Equal(new[] { 3L, 2L }, plan.OverBudgetRowIds); // old screenshot first
        Assert.Equal(1700L, plan.BytesFreed);
        Assert.Equal(100L, plan.BytesAfter);        // only the segment survives
        Assert.Equal(3, plan.RowIds.Count);
    }

    [Fact]
    public void An_impossible_budget_is_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new OutboxBudget(0, 0, TimeSpan.FromDays(7), TimeSpan.FromDays(30)));

        // if the target were larger than the cap, hysteresis would have no meaning
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new OutboxBudget(1000, 2000, TimeSpan.FromDays(7), TimeSpan.FromDays(30)));

        // if the segment retention were shorter, the pay data would be deleted first
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new OutboxBudget(1000, 600, TimeSpan.FromDays(7), TimeSpan.FromDays(3)));
    }

    [Fact]
    public void The_default_budget_tolerates_seven_days_offline()
    {
        // ~170 MB a day x 7 days = about 1.2 GB, cap 2 GiB
        const long sevenDays = 7L * 170 * 1024 * 1024;

        Assert.True(OutboxBudget.Default.CapBytes > sevenDays);
        Assert.True(OutboxBudget.Default.TargetBytes < OutboxBudget.Default.CapBytes);
        Assert.Equal(TimeSpan.FromDays(7), OutboxBudget.Default.MaxAge);
        Assert.Equal(TimeSpan.FromDays(30), OutboxBudget.Default.SegmentMaxAge);
    }
}
