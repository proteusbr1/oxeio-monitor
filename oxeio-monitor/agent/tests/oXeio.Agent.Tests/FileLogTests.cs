using oXeio.Agent.Storage;

namespace oXeio.Agent.Tests;

/// <summary>
/// H08: does the agent's log file really get written to disk?
///
/// Careful: real files are written here, not mocks, because the things that can go
/// wrong are in the file system itself: a missing folder, writing while the file is
/// open, renaming when the day changes. A mock could test none of them.
/// </summary>
public class FileLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(
        Path.GetTempPath(), "oxeio-logtest-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    private string Read() => File.ReadAllText(Path.Combine(_dir, FileLog.CurrentFileName));

    /// <summary>The folder does **not exist**, which is exactly the state at first boot.</summary>
    [Fact]
    public void ফোল্ডার_না_থাকলেও_লেখে()
    {
        var log = new FileLog(_dir);

        log.Info("hello");

        Assert.Contains("hello", Read());
    }

    [Fact]
    public void তিনটে_মাত্রাই_আলাদা_করে_চেনা_যায়()
    {
        var log = new FileLog(_dir);

        log.Info("ok");
        log.Warn("hmm");
        log.Error("bad", new InvalidOperationException("boom"));

        var text = Read();

        Assert.Contains("INFO ", text);
        Assert.Contains("WARN ", text);
        Assert.Contains("ERROR", text);
        // Both the exception type and the message: with just "bad", nobody reading the
        // log would understand what really happened.
        Assert.Contains("InvalidOperationException", text);
        Assert.Contains("boom", text);
    }

    /// <summary>
    /// Careful: writing the log must never take the caller down. Here a **file** is put
    /// where the folder should be, so `Directory.CreateDirectory` throws. If that
    /// reached the caller the sync worker would die, turning a log problem into a data-loss
    /// problem.
    /// </summary>
    [Fact]
    public void লিখতে_না_পারলেও_ছোড়ে_না()
    {
        var blocked = Path.Combine(_dir, "blocked");
        Directory.CreateDirectory(_dir);
        File.WriteAllText(blocked, "i am a file, not a folder");

        var log = new FileLog(blocked);

        log.Info("this goes nowhere");
        log.Error("neither does this", new Exception("x"));
    }

    [Fact]
    public void স্টার্টআপ_লাইনে_ভার্সন_সার্ভার_আর_পাথ_থাকে()
    {
        var log = new FileLog(_dir);

        log.Startup("0.1.0", "https://oxeio.office.local", @"C:\ProgramData\oXeio");

        var text = Read();

        Assert.Contains("0.1.0", text);
        Assert.Contains("oxeio.office.local", text);
        Assert.Contains(@"C:\ProgramData\oXeio", text);
    }

    /// <summary>
    /// When the day changes the current file is renamed with a date. That cannot be
    /// tested directly here (the clock cannot be changed), so the name-parsing rule is
    /// what is checked; the whole retention calculation rests on it.
    /// </summary>
    [Theory]
    [InlineData("agent-2026-08-12.log", true)]
    [InlineData("agent-2026-13-40.log", false)]  // impossible date
    [InlineData("agent.log", false)]             // the current file: never deleted
    [InlineData("outbox-drops.log", false)]      // another module's log
    [InlineData("outbox-drops.log.1", false)]
    [InlineData("watchdog.log", false)]
    public void শুধু_নিজের_আর্কাইভই_চেনে(string name, bool expected) =>
        Assert.Equal(expected, FileLog.DayFromName(name) is not null);

    [Fact]
    public void নাম_থেকে_তারিখটা_ঠিকঠাক_পড়ে() =>
        Assert.Equal(new DateOnly(2026, 8, 12), FileLog.DayFromName("agent-2026-08-12.log"));

    /**
     * Careful: the runbook tells the admin to run `Get-Content …gent.log`, and
     * **Windows PowerShell 5.1 treats a file without a BOM as ANSI**, so every
     * `·` `—` `✅` shows up broken as `Â·` `â€”` `âœ…`. The file is written correctly;
     * it just cannot be read.
     *
     * Caught by running it on a real machine, by eye, not by a test.
     */
    [Fact]
    public void নতুন_ফাইলের_শুরুতে_utf8_bom_বসে()
    {
        var log = new FileLog(_dir);
        log.Info("hello · world — ✅");

        var raw = System.IO.File.ReadAllBytes(Path.Combine(_dir, FileLog.CurrentFileName));

        Assert.Equal(0xEF, raw[0]);
        Assert.Equal(0xBB, raw[1]);
        Assert.Equal(0xBF, raw[2]);
    }

    /** Writing it on every line would pile up BOMs in the middle and corrupt the text. */
    [Fact]
    public void bom_একবারই_বসে()
    {
        var log = new FileLog(_dir);
        log.Info("এক");
        log.Info("দুই");
        log.Info("তিন");

        var raw = System.IO.File.ReadAllBytes(Path.Combine(_dir, FileLog.CurrentFileName));
        var count = 0;
        for (var i = 0; i + 2 < raw.Length; i++)
        {
            if (raw[i] == 0xEF && raw[i + 1] == 0xBB && raw[i + 2] == 0xBF) count++;
        }

        Assert.Equal(1, count);
    }
}
