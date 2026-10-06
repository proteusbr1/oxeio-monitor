using oXeio.Core.Capture;

namespace oXeio.Core.Tests;

public class SlotSchedulerTests
{
    private static readonly DateTimeOffset Nine =
        new(2026, 8, 9, 3, 0, 0, TimeSpan.Zero); // 9 AM in Dhaka

    [Fact]
    public void ছবি_সবসময়_নিজের_স্লটের_ভেতরেই_ওঠে()
    {
        var s = new SlotScheduler(5, new Random(42));
        var at = Nine;

        for (var i = 0; i < 500; i++)
        {
            var slot = s.Next(at);
            Assert.InRange(slot.FireAt, slot.SlotStart, slot.SlotStart.AddMinutes(5));
            at = slot.FireAt;
        }
    }

    [Fact]
    public void দুই_ঘণ্টায়_চব্বিশটা_স্লট()
    {
        var s = new SlotScheduler(5, new Random(7));

        // Next() always gives the *next* slot, so start a little early to get the 9 o'clock slot
        var at = Nine.AddMinutes(-5);
        var count = 0;

        while (true)
        {
            var slot = s.Next(at);
            if (slot.SlotStart >= Nine.AddHours(2)) break;
            count++;
            at = slot.SlotStart;
        }

        Assert.Equal(24, count); // 12 per hour x 2
    }

    [Fact]
    public void পরপর_দুটো_ছবির_ব্যবধান_একরকম_হয়_না()
    {
        var s = new SlotScheduler(5, new Random(1234));
        var at = Nine;
        var gaps = new List<double>();

        for (var i = 0; i < 30; i++)
        {
            var slot = s.Next(at);
            gaps.Add((slot.FireAt - at).TotalSeconds);
            at = slot.FireAt;
        }

        // if it could be predicted the whole scheme would be pointless (A01)
        Assert.True(gaps.Distinct().Count() > 25, "ব্যবধানগুলো যথেষ্ট আলাদা নয়");
    }

    [Fact]
    public void স্লটের_শুরু_সবসময়_পাঁচ_মিনিটের_ঘরে()
    {
        var s = new SlotScheduler(5, new Random(9));

        for (var i = 0; i < 100; i++)
        {
            var slot = s.Next(Nine.AddSeconds(i * 37));
            Assert.Equal(0, slot.SlotStart.Minute % 5);
            Assert.Equal(0, slot.SlotStart.Second);
        }
    }
}
