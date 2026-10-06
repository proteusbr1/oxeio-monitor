using System.Runtime.Versioning;

using Microsoft.Data.Sqlite;

using oXeio.Core.Agent;

namespace oXeio.Agent.Storage;

/// <summary>
/// The outbox SQL: schema, migrations and pragmas. No ORM, no migration framework.
///
/// <b>Why hand-written SQL:</b> there is one table and seven queries. EF Core would add a
/// ~3 MB dependency, model building at startup and its own migration-history table, and each
/// of those gets a chance to break at exactly the moment a machine comes back from seven
/// days offline holding a week of payroll data.
///
/// <b>Migrations:</b> <c>PRAGMA user_version</c>, an integer inside the SQLite file header.
/// No extra table is needed, and it is part of the transaction, so the state "the schema
/// changed but the version did not" cannot happen.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class OutboxSchema
{
    /// <summary>
    /// The schema this build understands. When adding a column, bump this and write a new
    /// <c>if (from &lt; N)</c> step in <see cref="Migrate"/>.
    /// Careful: never change old steps; a machine in the field can start from any version.
    /// </summary>
    public const int Version = 1;

    /// <summary>
    /// Careful: AUTOINCREMENT is deliberate, and it is this table's most important decision.
    ///
    /// With a plain INTEGER PRIMARY KEY, SQLite hands out the new rowid as "current max + 1",
    /// so after rows are deleted <b>ids get reused</b>. We decide upload order by row_id, so a
    /// reused id would put old data behind new data and a seven-day backlog would go out in a
    /// scrambled order. AUTOINCREMENT remembers the maximum in sqlite_sequence and never goes
    /// backwards.
    ///
    /// Careful: time is stored as INTEGER (unix ms, UTC), not text. ISO-8601 text carries an
    /// offset (+06:00), and in a lexicographic comparison times with "+06:00" compare wrongly
    /// against times with "+00:00", so <c>not_before</c> comparisons would silently be wrong
    /// and retries would run either far too early or far too late.
    ///
    /// kind is text (see the comment on <see cref="OutboundKind"/>): if numbers were stored,
    /// adding an enum member in the middle later would send old rows to the wrong endpoint.
    /// </summary>
    private const string CreateV1 = """
        CREATE TABLE IF NOT EXISTS outbox (
            row_id            INTEGER PRIMARY KEY AUTOINCREMENT,
            client_uuid       TEXT    NOT NULL,
            kind              TEXT    NOT NULL,
            enqueued_at_ms    INTEGER NOT NULL,
            payload           TEXT    NOT NULL,
            file_path         TEXT    NULL,
            size_bytes        INTEGER NOT NULL,
            attempts          INTEGER NOT NULL DEFAULT 0,
            not_before_ms     INTEGER NULL,
            lease_id          TEXT    NULL,
            lease_expires_ms  INTEGER NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_uuid
            ON outbox(client_uuid);

        CREATE INDEX IF NOT EXISTS ix_outbox_pending
            ON outbox(kind, row_id)
            WHERE lease_id IS NULL;

        CREATE INDEX IF NOT EXISTS ix_outbox_leased
            ON outbox(lease_expires_ms)
            WHERE lease_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS ix_outbox_kind
            ON outbox(kind);
        """;

    /// <summary>
    /// Pragmas for the write connection. Careful: the order matters.
    /// <c>auto_vacuum</c> can only be changed <b>before the table is created</b> (otherwise a
    /// full VACUUM is needed), and <c>journal_mode</c> cannot be changed inside a transaction.
    ///
    /// <b>Why WAL:</b> reads are not blocked while writing. The tray thread reads the queue
    /// depth every few seconds; in rollback-journal mode that read would collide with the
    /// sync worker's writes and give "database is locked".
    ///
    /// <b>What WAL does after an unclean shutdown:</b> <c>outbox.db-wal</c> and <c>-shm</c>
    /// stay on disk. The next connection to open the DB runs recovery: it reads the WAL frames,
    /// verifies each checksum, and replays <b>up to the last valid commit record</b>; a
    /// half-written frame after that is silently dropped. So the DB is never left half-written.
    /// Careful: therefore never delete the -wal file by hand after a crash; that would throw
    /// away committed transactions (and the hours collected with them).
    ///
    /// <b>Why synchronous=FULL, not NORMAL:</b> with WAL + NORMAL there is no fsync on each
    /// commit, only at checkpoints. The DB never gets corrupted that way, but
    /// <b>a power loss drops the last few commits</b>. Our write rate is one small row per
    /// minute, so the fsync cost is invisible here (the operating profile says plainly that
    /// throughput is irrelevant), while a lost commit means lost pay. Where the cost is near
    /// zero, buying durability is the right call.
    ///
    /// <c>wal_autocheckpoint=256</c> (~1 MB): keeps the WAL small, so crash recovery has less
    /// to replay and the extra file on disk stays small.
    /// </summary>
    private static readonly string[] WritePragmas =
    [
        // Careful: do not give up the moment the lock is busy; backup software or AV can
        // hold the file for a moment.
        "PRAGMA busy_timeout = 10000;",
        "PRAGMA journal_mode = WAL;",
        "PRAGMA synchronous = FULL;",
        "PRAGMA wal_autocheckpoint = 256;",
        "PRAGMA temp_store = MEMORY;",
        // Only effective on a new DB; silently ignored on an existing one.
        "PRAGMA auto_vacuum = INCREMENTAL;",
    ];

    /// <summary>
    /// The read connection. <c>query_only</c> guarantees that not a single byte can be written
    /// by mistake from the tray path, so there is never a write-lock fight with the write
    /// connection.
    ///
    /// Careful: the connection is deliberately not <c>Mode=ReadOnly</c>. On a WAL database even
    /// a read-only connection has to write to the <c>-shm</c> shared-memory file; if the file
    /// does not exist yet, a ReadOnly connection cannot create it and fails with
    /// SQLITE_CANTOPEN. So the connection is read-write, but its behavior is pinned to
    /// read-only by the pragma.
    /// </summary>
    private static readonly string[] ReadPragmas =
    [
        "PRAGMA busy_timeout = 5000;",
        "PRAGMA temp_store = MEMORY;",
        "PRAGMA query_only = ON;",
    ];

    public static void ApplyWritePragmas(SqliteConnection conn)
    {
        foreach (var pragma in WritePragmas) Execute(conn, pragma);

        // journal_mode returns the resulting value; we need to know if WAL was not granted.
        // On network drives or with some filter drivers WAL is unavailable and SQLite quietly
        // stays in delete-journal mode.
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode;";
        JournalMode = cmd.ExecuteScalar() as string ?? "?";
    }

    public static void ApplyReadPragmas(SqliteConnection conn)
    {
        foreach (var pragma in ReadPragmas) Execute(conn, pragma);
    }

    /// <summary>The last value seen, shown in the startup log ("wal" is expected).</summary>
    public static string JournalMode { get; private set; } = "?";

    /// <summary>
    /// Advances the schema. Returns (previous version, current version).
    ///
    /// Careful: the whole job runs in one transaction, and <c>user_version</c> is bumped inside
    /// that same transaction. If power fails midway through a migration, either all of it
    /// happened or none of it did; a "half-migrated" DB could not be recognized when opened
    /// next time.
    /// </summary>
    public static (int From, int To) Migrate(SqliteConnection conn, Action<string> log)
    {
        var from = ReadUserVersion(conn);

        if (from == Version) return (from, Version);

        if (from > Version)
        {
            // Downgrade (a newer agent replaced by an older one). Stopping would make the
            // machine stop collecting data; since columns are only ever added, old queries
            // will most likely keep working. So complain loudly and carry on.
            log($"⚠️ outbox schema is v{from}, but this build understands v{Version} — " +
                "the agent was probably downgraded. Carrying on.");
            return (from, from);
        }

        using var tx = conn.BeginTransaction();

        if (from < 1)
        {
            using var cmd = conn.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = CreateV1;
            cmd.ExecuteNonQuery();
        }

        // future steps go here:  if (from < 2) { ... ALTER TABLE outbox ADD COLUMN ... }

        using (var bump = conn.CreateCommand())
        {
            bump.Transaction = tx;
            // Careful: PRAGMA cannot take bound parameters; Version is a const int, so
            // string concatenation here leaves no room for injection.
            bump.CommandText = $"PRAGMA user_version = {Version};";
            bump.ExecuteNonQuery();
        }

        tx.Commit();
        return (from, Version);
    }

    public static int ReadUserVersion(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA user_version;";
        return Convert.ToInt32(cmd.ExecuteScalar() ?? 0);
    }

    /// <summary>
    /// Whether the file is readable at all. Returns <c>"ok"</c> or a description of the problem.
    ///
    /// <c>quick_check</c> is used, not the full <c>integrity_check</c>: quick_check verifies
    /// each page's structure but does not cross-check index contents, so it is much faster.
    /// All we need is "is the file garbage?", and this catches that.
    /// </summary>
    public static string QuickCheck(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA quick_check(1);";
        return cmd.ExecuteScalar() as string ?? "unknown";
    }

    private static void Execute(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
