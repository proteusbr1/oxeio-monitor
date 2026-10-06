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
    public void It_writes_even_when_the_folder_does_not_exist()
    {
        var log = new FileLog(_dir);

        log.Info("hello");

        Assert.Contains("hello", Read());
    }

    [Fact]
    public void All_three_levels_are_told_apart()
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
    public void It_does_not_throw_when_it_cannot_write()
    {
        var blocked = Path.Combine(_dir, "blocked");
        Directory.CreateDirectory(_dir);
        File.WriteAllText(blocked, "i am a file, not a folder");

        var log = new FileLog(blocked);

        log.Info("this goes nowhere");
        log.Error("neither does this", new Exception("x"));
    }

    [Fact]
    public void The_startup_line_carries_version_server_and_path()
    {
        var log = new FileLog(_dir);

        log.Startup("0.1.0", "https://monitor.example.com", @"C:\ProgramData\oXeio");

        var text = Read();

        Assert.Contains("0.1.0", text);
        Assert.Contains("monitor.example.com", text);
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
    public void Only_its_own_archives_are_recognised(string name, bool expected) =>
        Assert.Equal(expected, FileLog.DayFromName(name) is not null);

    [Fact]
    public void The_date_is_read_correctly_from_the_name() =>
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
    public void A_new_file_starts_with_a_UTF8_BOM()
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
    public void The_BOM_is_written_only_once()
    {
        var log = new FileLog(_dir);
        log.Info("一");
        log.Info("二");
        log.Info("三");

        var raw = System.IO.File.ReadAllBytes(Path.Combine(_dir, FileLog.CurrentFileName));
        var count = 0;
        for (var i = 0; i + 2 < raw.Length; i++)
        {
            if (raw[i] == 0xEF && raw[i + 1] == 0xBB && raw[i + 2] == 0xBF) count++;
        }

        Assert.Equal(1, count);
    }
}
