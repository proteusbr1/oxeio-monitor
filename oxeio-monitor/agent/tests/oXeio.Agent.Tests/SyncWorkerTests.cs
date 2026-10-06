using oXeio.Agent.Storage;
using oXeio.Agent.Sync;
using oXeio.Core.Agent;
using oXeio.Core.Models;

namespace oXeio.Agent.Tests;

public class SyncWorkerTests
{
    private static readonly DateTimeOffset T0 =
        new(2026, 8, 10, 10, 0, 0, TimeSpan.FromHours(6));

    private static ActivitySegment Segment(int i) => new()
    {
        ClientUuid = Guid.Parse($"00000000-0000-0000-0000-{i:D12}"),
        State = SegmentState.Active,
        StartedAt = T0.AddMinutes(i),
        EndedAt = T0.AddMinutes(i + 1),
        DurationSec = 60,
    };

    private static AgentEventRecord Event(int i, string type) => new()
    {
        ClientUuid = Guid.Parse($"00000000-0000-0000-0001-{i:D12}"),
        Type = type,
        OccurredAt = T0.AddMinutes(i),
    };

    private static async Task<FakeOutbox> Filled(int count)
    {
        var box = new FakeOutbox();
        for (var i = 1; i <= count; i++)
            await box.EnqueueAsync(OutboxCodec.Item(Segment(i), T0));
        return box;
    }

    private static SyncWorker Worker(FakeOutbox box, FakeSyncClient client) =>
        new(box, client, clock: () => T0);

    [Fact]
    public async Task On_success_every_row_leaves_the_queue()
    {
        var box = await Filled(10);
        var client = new FakeSyncClient();

        await Worker(box, client).DrainOnceAsync();

        Assert.Empty(box.RemainingUuids);
        Assert.Equal(10, client.AcceptedSegments);
    }

    [Fact]
    public async Task A_transient_failure_loses_nothing()
    {
        var box = await Filled(10);
        var client = new FakeSyncClient();
        client.ForcedOutcomes.Enqueue(SyncOutcome.Transient);

        await Worker(box, client).DrainOnceAsync();

        Assert.Equal(10, box.RemainingUuids.Count);
        Assert.Empty(box.Abandoned);
        Assert.Equal(1, box.RetriedBatches);
    }

    /// <summary>
    /// This is the most important test. 1 of 20 records is bad, and the server returns
    /// 400 for the whole batch. A naive implementation would drop all 20, losing 19
    /// people's work records because of one person's mistake.
    /// </summary>
    [Fact]
    public async Task One_bad_record_does_not_sink_the_others()
    {
        var box = await Filled(20);
        var client = new FakeSyncClient();
        client.PoisonUuids.Add(Segment(7).ClientUuid);

        var worker = new SyncWorker(box, client, clock: () => T0);

        // The batch halves until the culprit is alone; it takes a few cycles
        for (var i = 0; i < 12; i++) await worker.DrainOnceAsync();

        Assert.Empty(box.RemainingUuids);

        // Exactly one was dropped, and it is the culprit
        Assert.Single(box.Abandoned);
        Assert.Contains(Segment(7).ClientUuid.ToString(), box.Abandoned[0]);

        // The other 19 reached the server
        Assert.Equal(19, client.AcceptedSegments);
    }

    [Fact]
    public async Task The_batch_really_shrinks_to_find_the_bad_record()
    {
        var box = await Filled(20);
        var client = new FakeSyncClient();
        client.PoisonUuids.Add(Segment(3).ClientUuid);

        var worker = new SyncWorker(box, client, clock: () => T0);
        for (var i = 0; i < 12; i++) await worker.DrainOnceAsync();

        // The first attempt takes all 20, then it shrinks step by step
        Assert.Equal(20, client.SegmentBatchSizes[0]);
        Assert.Contains(1, client.SegmentBatchSizes);
        Assert.True(
            client.SegmentBatchSizes.Count >= 4,
            "was the batch dropped without narrowing it first?");
    }

    [Fact]
    public async Task Revoke_does_not_delete_the_data()
    {
        var box = await Filled(5);
        var client = new FakeSyncClient();
        client.ForcedOutcomes.Enqueue(SyncOutcome.Revoked);

        var worker = new SyncWorker(box, client, clock: () => T0);
        await worker.DrainOnceAsync();

        Assert.True(worker.Revoked);
        Assert.Empty(box.Abandoned);

        // Careful: a revoke can be a mistake; the only way to get the rows back is for them to
        // survive
        Assert.Equal(5, box.RemainingUuids.Count);
    }

    [Fact]
    public async Task No_more_attempts_after_revoke()
    {
        var box = await Filled(5);
        var client = new FakeSyncClient();
        client.ForcedOutcomes.Enqueue(SyncOutcome.Revoked);

        var worker = new SyncWorker(box, client, clock: () => T0);
        await worker.DrainOnceAsync();
        var callsAfterRevoke = client.SegmentBatchSizes.Count;

        await worker.DrainOnceAsync();
        await worker.DrainOnceAsync();

        Assert.Equal(callsAfterRevoke, client.SegmentBatchSizes.Count);
    }

    [Fact]
    public async Task An_unreadable_row_does_not_block_the_queue()
    {
        var box = new FakeOutbox();
        await box.EnqueueAsync(new OutboxItem
        {
            ClientUuid = Guid.NewGuid(),
            Kind = OutboundKind.Segment,
            EnqueuedAt = T0,
            Payload = "{ this is not valid JSON",
            SizeBytes = 20,
        });

        var client = new FakeSyncClient();
        var worker = new SyncWorker(box, client, clock: () => T0);

        await worker.DrainOnceAsync();

        // The corrupt row was dropped and the queue is clear; it did not block everything at the
        // head
        Assert.Empty(box.RemainingUuids);
        Assert.Single(box.Abandoned);
    }

    [Fact]
    public async Task Segments_go_before_screenshots()
    {
        var box = new FakeOutbox();
        await box.EnqueueAsync(OutboxCodec.Item(
            new ScreenshotRecord
            {
                ClientUuid = Guid.NewGuid(),
                SlotStart = T0,
                CapturedAt = T0,
                MonitorIndex = 0,
            },
            webpPath: Path.Combine(Path.GetTempPath(), "oxeio-missing.webp"),
            fileBytes: 1000,
            now: T0));
        await box.EnqueueAsync(OutboxCodec.Item(Segment(1), T0));

        var client = new FakeSyncClient();
        await Worker(box, client).DrainOnceAsync();

        // The segment went; the image was dropped because its file does not exist, but
        // after the segment, not before
        Assert.Equal(1, client.AcceptedSegments);
    }

    [Fact]
    public async Task Nothing_happens_on_an_empty_queue()
    {
        var box = new FakeOutbox();
        var client = new FakeSyncClient();

        await Worker(box, client).DrainOnceAsync();

        Assert.Empty(client.SegmentBatchSizes);
        Assert.Equal(0, box.AckedBatches);
    }

    /// <summary>
    /// G136: on shutdown <c>DisposeAsync</c> sends the farewell events separately,
    /// before the full drain. <see cref="SyncWorker.DrainKindOnceAsync"/>(Event) sends
    /// only events and does not touch segments, so even with a large segment backlog
    /// shutdown/agent_stop reaches the server, and no false agent_down appears the next day.
    /// </summary>
    [Fact]
    public async Task DrainKindOnce_sends_only_that_kind()
    {
        var box = new FakeOutbox();
        // Five segments are queued first; a normal drain would send these first
        for (var i = 1; i <= 5; i++)
            await box.EnqueueAsync(OutboxCodec.Item(Segment(i), T0));
        await box.EnqueueAsync(OutboxCodec.Item(Event(1, AgentEventTypes.Shutdown), T0));
        await box.EnqueueAsync(OutboxCodec.Item(Event(2, AgentEventTypes.AgentStop), T0));

        var client = new FakeSyncClient();
        await Worker(box, client).DrainKindOnceAsync(OutboundKind.Event);

        // Both farewell events went
        Assert.Equal(2, client.AcceptedEvents);
        // Segments were not touched: not sent to the server, all five still queued
        Assert.Equal(0, client.AcceptedSegments);
        Assert.Equal(5, box.RemainingUuids.Count);
    }
}
