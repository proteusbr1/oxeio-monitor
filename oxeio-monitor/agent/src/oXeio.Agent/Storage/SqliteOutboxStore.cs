using System.Runtime.Versioning;

using Microsoft.Data.Sqlite;

using oXeio.Core.Agent;

namespace oXeio.Agent.Storage;

/// <summary>
/// The SQLite implementation of <see cref="IOutboxStore"/>. Whether a week-long internet
/// outage costs the office its payroll data is decided by this file.
///
/// <b>What happens if the process dies at each step of the lease/ack cycle</b> (kill it at
/// every step and think it through):
/// <code>
/// 1. LeaseAsync  - the row stays where it is, only lease_id is set (one transaction).
///                  Dying now: the row stays "leased". At the next startup all leases
///                  are released, so it is uploaded again. No harm.
/// 2. HTTP POST   - dying here: the server may or may not have written it. The row
///                  survives, so it is sent again; the server dedupes on clientUuid. No harm.
/// 3. AckAsync    - row DELETE + commit. Dying before the commit is the same as step 2.
///                  Dying after the commit but before the .webp is deleted leaves the file
///                  orphaned; <see cref="SweepOrphanFilesAsync"/> picks it up at the next
///                  startup.
/// </code>
/// So data is <b>never lost</b> at any step; the worst outcome is one extra send, which
/// costs nothing (see the IOutboxStore doc).
///
/// <b>Threading:</b> two connections.
/// <list type="bullet">
/// <item>There is exactly one <b>write</b> connection, and <see cref="_writeGate"/>
/// (SemaphoreSlim) hands it to one caller at a time. The tracking thread enqueues and the
/// sync worker leases/acks; a SQLite connection object is not thread-safe, so this gate is
/// not up for debate, it is mandatory.</item>
/// <item>The <b>read</b> connection is separate, behind <see cref="_readGate"/>. The tray
/// asks for the depth every few seconds; on the same gate it would be stuck behind a
/// 500-row batch insert. In WAL, reads and writes run together, so a separate connection
/// means the tray never waits for a write.</item>
/// </list>
/// Both gates are <c>async</c>, so no thread is blocked while waiting.
///
/// Careful: synchronous ADO.NET calls (<c>ExecuteReader</c>, <c>ExecuteNonQuery</c>) are
/// used inside on purpose. SQLite has no real async I/O; <c>ExecuteNonQueryAsync</c> makes
/// the same blocking call internally and just adds an extra state machine. The outer API is
/// async because of the interface and because waiting on the gate really is async.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class SqliteOutboxStore : IOutboxStore
{
    /// <summary>How often the same error is logged. Once a second would fill an already full disk.</summary>
    private static readonly TimeSpan ErrorLogWindow = TimeSpan.FromMinutes(1);

    /// <summary>Used when a lease is requested with 0 or a negative duration by mistake.</summary>
    private static readonly TimeSpan DefaultLeaseFor = TimeSpan.FromMinutes(5);

    /// <summary>Most rows written individually to the drop log; beyond that, only a summary.</summary>
    private const int MaxDropLogLines = 50;

    private readonly SqliteConnection _write;
    private readonly SqliteConnection _read;
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly SemaphoreSlim _readGate = new(1, 1);
    private readonly Action<string> _log;
    private readonly DropLog _drops;

    private DateTimeOffset _lastWriteErrorLoggedAt = DateTimeOffset.MinValue;
    private int _evictionsSinceVacuum;
    private bool _disposed;

    private SqliteOutboxStore(
        OutboxPaths paths, SqliteConnection write, SqliteConnection read,
        Action<string> log, DropLog drops)
    {
        Paths = paths;
        _write = write;
        _read = read;
        _log = log;
        _drops = drops;
    }

    /// <summary>The screenshot writer takes destination paths from here; it creates no folders itself.</summary>
    public OutboxPaths Paths { get; }

    /// <summary>
    /// Why the last write failed (usually a full disk), otherwise null.
    /// The sync worker can see this and run a trimming pass right away, and the tray can
    /// show health as "Degraded".
    /// </summary>
    public string? LastWriteError { get; private set; }

    public DateTimeOffset? LastWriteErrorAt { get; private set; }

    /// <summary>The drop-log path, shown once at startup.</summary>
    public string DropLogPath => _drops.FilePath;

    // ── opening ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Opens the outbox. Once, at startup. Synchronous, because nothing else can start after
    /// it; making it async would only be pretense.
    ///
    /// Careful: if the file is corrupt (the file system itself wrote wrongly during a power
    /// loss, or AV truncated the file) and we threw here, the agent would die immediately on
    /// every start, so that machine would lose tracking <b>for good</b>. So a corrupt file is
    /// moved aside and a new DB is created: what had accumulated is lost (and recorded in the
    /// drop log), but from tomorrow the accounting runs again.
    /// </summary>
    public static SqliteOutboxStore Open(OutboxPaths? paths = null, Action<string>? log = null)
    {
        paths ??= OutboxPaths.Default;
        var write = log ?? new Action<string>(_ => { });

        paths.EnsureCreated();
        var drops = new DropLog(paths.Logs);

        if (paths.IsFallback)
        {
            write($"⚠️ Outbox is at {paths.Root} ({paths.ResolutionNote}) — deleting the profile loses the queue");
        }

        QuarantineIfCorrupt(paths, write, drops);

        var writeConn = OpenConnection(paths.Database);
        OutboxSchema.ApplyWritePragmas(writeConn);

        var (from, to) = OutboxSchema.Migrate(writeConn, write);
        if (from != to) write($"outbox schema v{from} → v{to}");

        var readConn = OpenConnection(paths.Database);
        OutboxSchema.ApplyReadPragmas(readConn);

        var store = new SqliteOutboxStore(paths, writeConn, readConn, write, drops);

        store.ReclaimAllLeases();
        store.PurgeUnknownKinds();

        var depth = ReadDepth(writeConn);
        write($"outbox: {paths.Database} (journal={OutboxSchema.JournalMode}) — " +
              $"{depth.Total} rows, {depth.BytesTotal / 1024.0 / 1024.0:F1} MB");

        return store;
    }

    private static SqliteConnection OpenConnection(string dbPath)
    {
        // Careful: pooling is off. The two connections stay open for the life of the process,
        // so a pool gains nothing; worse, even after Dispose the pool would hold the file and
        // moving a corrupt DB aside would fail with "file in use".
        var cs = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = false,
            DefaultTimeout = 30,
        }.ToString();

        var conn = new SqliteConnection(cs);
        conn.Open();
        return conn;
    }

    /// <summary>
    /// A health check once before opening. If corrupt, the DB (and its -wal/-shm) is moved
    /// aside, not deleted, because keeping a chance of manual recovery later is the cheap
    /// option.
    /// </summary>
    private static void QuarantineIfCorrupt(OutboxPaths paths, Action<string> log, DropLog drops)
    {
        if (!File.Exists(paths.Database)) return;

        string verdict;
        try
        {
            using var probe = OpenConnection(paths.Database);
            verdict = OutboxSchema.QuickCheck(probe);
        }
        catch (SqliteException ex)
        {
            verdict = $"SQLite {ex.SqliteErrorCode}: {ex.Message}";
        }
        catch (InvalidOperationException ex)
        {
            verdict = ex.Message;
        }

        if (verdict == "ok") return;

        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss");
        var moved = 0;
        foreach (var file in new[] { paths.Database, paths.DatabaseWal, paths.DatabaseShm })
        {
            try
            {
                if (!File.Exists(file)) continue;
                File.Move(file, $"{file}.corrupt-{stamp}", overwrite: true);
                moved++;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        var line = $"CORRUPT\tThe database is corrupt ({verdict}) — {moved} files were moved aside, " +
                   "a new empty outbox is being created. Every queued row ends here.";
        drops.Write(line);
        log("⚠️ " + line);
    }

    // ── enqueue ─────────────────────────────────────────────────────────────

    private const string InsertSql = """
        INSERT INTO outbox (client_uuid, kind, enqueued_at_ms, payload, file_path, size_bytes)
        VALUES ($uuid, $kind, $at, $payload, $file, $size)
        ON CONFLICT(client_uuid) DO NOTHING;
        """;

    /// <summary>
    /// Careful: <paramref name="ct"/> is deliberately not passed to the gate. If Enqueue
    /// threw when the shutdown token is cancelled, the segments created right at shutdown,
    /// the newest ones that exist only in RAM, would be lost for good. The gate is never held
    /// for more than a few milliseconds, so waiting and writing is safe.
    ///
    /// Returns <c>-1</c> on failure instead of throwing (disk-full behavior, see below).
    /// </summary>
    public async Task<long> EnqueueAsync(OutboxItem item, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        ThrowIfDisposed();

        await _writeGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            using var cmd = _write.CreateCommand();
            cmd.CommandText = InsertSql;
            AddInsertParameters(cmd, item);

            var changed = cmd.ExecuteNonQuery();
            ClearWriteError();

            if (changed > 0) return LastRowId();

            // ON CONFLICT DO NOTHING: the same clientUuid is already in the queue.
            // That is not a failure but desirable: if a producer crashes and enqueues the
            // same record again, two copies would eat disk, yet the server keeps only one.
            return FindRowIdByUuid(item.ClientUuid);
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 1, item.Kind);
            return -1;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Many rows in one transaction. Returns <c>0</c> on failure; a half-inserted batch
    /// never exists (an interface requirement).
    /// </summary>
    public async Task<int> EnqueueManyAsync(IReadOnlyList<OutboxItem> items, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(items);
        ThrowIfDisposed();
        if (items.Count == 0) return 0;

        await _writeGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            using var tx = _write.BeginTransaction();
            using var cmd = _write.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = InsertSql;

            // Parameters are created once and only the values change; creating a new command
            // 500 times would mean preparing the SQL 500 times.
            var pUuid = cmd.Parameters.AddWithValue("$uuid", "");
            var pKind = cmd.Parameters.AddWithValue("$kind", "");
            var pAt = cmd.Parameters.AddWithValue("$at", 0L);
            var pPayload = cmd.Parameters.AddWithValue("$payload", "");
            var pFile = cmd.Parameters.AddWithValue("$file", DBNull.Value);
            var pSize = cmd.Parameters.AddWithValue("$size", 0L);

            var inserted = 0;
            foreach (var item in items)
            {
                pUuid.Value = item.ClientUuid.ToString("D");
                pKind.Value = item.Kind.ToString();
                pAt.Value = ToMs(item.EnqueuedAt);
                pPayload.Value = item.Payload;
                pFile.Value = (object?)item.FilePath ?? DBNull.Value;
                pSize.Value = item.SizeBytes;

                inserted += cmd.ExecuteNonQuery();
            }

            tx.Commit();
            ClearWriteError();
            return inserted;
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, items.Count, items[0].Kind);
            return 0;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    // ── leasing ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Careful: ordered by <c>row_id</c>, not <c>enqueued_at_ms</c>, even though the
    /// interface says "oldest first". Reason: if a user (or NTP) sets the clock back, a row
    /// created later gets a timestamp smaller than an earlier row's, and sorting by time
    /// would send the backlog to the server out of order. row_id (AUTOINCREMENT) is pure
    /// insertion order, independent of any clock, so in practice it is the correct
    /// definition of "oldest first".
    /// </summary>
    public async Task<OutboxLease?> LeaseAsync(
        OutboundKind kind, int maxItems, TimeSpan leaseFor, DateTimeOffset now,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();
        if (maxItems <= 0) return null;
        if (maxItems > SyncLimits.MaxBatchSize) maxItems = SyncLimits.MaxBatchSize;
        if (leaseFor <= TimeSpan.Zero) leaseFor = DefaultLeaseFor;

        await _writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var leaseId = Guid.NewGuid();
            var expiresAt = now + leaseFor;

            using var tx = _write.BeginTransaction();

            var entries = new List<OutboxEntry>(Math.Min(maxItems, 64));
            using (var sel = _write.CreateCommand())
            {
                sel.Transaction = tx;
                sel.CommandText = """
                    SELECT row_id, client_uuid, kind, enqueued_at_ms, payload,
                           file_path, size_bytes, attempts
                    FROM outbox
                    WHERE kind = $kind
                      AND lease_id IS NULL
                      AND (not_before_ms IS NULL OR not_before_ms <= $now)
                    ORDER BY row_id
                    LIMIT $max;
                    """;
                sel.Parameters.AddWithValue("$kind", kind.ToString());
                sel.Parameters.AddWithValue("$now", ToMs(now));
                sel.Parameters.AddWithValue("$max", maxItems);

                using var reader = sel.ExecuteReader();
                while (reader.Read())
                {
                    entries.Add(new OutboxEntry
                    {
                        RowId = reader.GetInt64(0),
                        ClientUuid = ParseGuid(reader.GetString(1)),
                        Kind = kind,
                        EnqueuedAt = FromMs(reader.GetInt64(3)),
                        Payload = reader.GetString(4),
                        FilePath = reader.IsDBNull(5) ? null : reader.GetString(5),
                        SizeBytes = reader.GetInt64(6),
                        Attempts = reader.GetInt32(7),
                    });
                }
            }

            if (entries.Count == 0)
            {
                // Not committed; disposing the using block rolls back by itself.
                return null;
            }

            using (var upd = _write.CreateCommand())
            {
                upd.Transaction = tx;
                // "AND lease_id IS NULL" is extra protection: state is not supposed to change
                // within the same transaction, but keeping the condition makes it impossible
                // to steal someone else's lease in any circumstance.
                upd.CommandText = """
                    UPDATE outbox
                       SET lease_id = $lid, lease_expires_ms = $exp
                     WHERE row_id = $id AND lease_id IS NULL;
                    """;
                var pId = upd.Parameters.AddWithValue("$id", 0L);
                upd.Parameters.AddWithValue("$lid", leaseId.ToString("D"));
                upd.Parameters.AddWithValue("$exp", ToMs(expiresAt));

                foreach (var entry in entries)
                {
                    pId.Value = entry.RowId;
                    upd.ExecuteNonQuery();
                }
            }

            tx.Commit();
            ClearWriteError();

            return new OutboxLease
            {
                LeaseId = leaseId,
                Kind = kind,
                Entries = entries,
                ExpiresAt = expiresAt,
            };
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 0, kind);
            return null;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    // ── finishing a lease ───────────────────────────────────────────────────

    /// <inheritdoc/>
    public Task AckAsync(Guid leaseId, CancellationToken ct = default) =>
        CompleteLeaseAsync(leaseId, reason: null);

    /// <inheritdoc/>
    public Task AbandonAsync(Guid leaseId, string reason, CancellationToken ct = default) =>
        CompleteLeaseAsync(leaseId, string.IsNullOrWhiteSpace(reason) ? "(no reason given)" : reason);

    /// <summary>
    /// The SQL for ack and abandon is the same; the difference is only in the drop log. It is
    /// kept in one place so that fixing the file deletion in one does not get forgotten in
    /// the other.
    ///
    /// <b>Order:</b> first DELETE the row + commit, <b>then</b> unlink the file. The other way
    /// round (file first), dying before the commit would leave a row pointing at a file that
    /// no longer exists, and the next upload would say "file missing", become Permanent and
    /// write a false alarm to the drop log, even though the data had reached the server.
    /// With this order the worst outcome is a single orphaned .webp, which
    /// <see cref="SweepOrphanFilesAsync"/> picks up.
    ///
    /// Careful: no <c>ct</c> is taken. This call means the server has already accepted the
    /// data. If a shutdown cancelled it, the rows would stay and the next run would send the
    /// whole batch again; harmless, but pointless.
    /// </summary>
    private async Task CompleteLeaseAsync(Guid leaseId, string? reason)
    {
        ThrowIfDisposed();
        if (leaseId == Guid.Empty) return;

        await _writeGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            var lid = leaseId.ToString("D");
            var files = new List<string>();
            var logLines = reason is null ? null : new List<string>();
            var rows = 0;
            var bytes = 0L;

            using (var sel = _write.CreateCommand())
            {
                sel.CommandText = """
                    SELECT row_id, client_uuid, kind, file_path, size_bytes, attempts
                    FROM outbox WHERE lease_id = $lid ORDER BY row_id;
                    """;
                sel.Parameters.AddWithValue("$lid", lid);

                using var reader = sel.ExecuteReader();
                while (reader.Read())
                {
                    rows++;
                    bytes += reader.GetInt64(4);
                    if (!reader.IsDBNull(3)) files.Add(reader.GetString(3));

                    if (logLines is not null && logLines.Count < MaxDropLogLines)
                    {
                        logLines.Add(
                            $"ABANDON\t{reader.GetString(2)}\trow={reader.GetInt64(0)}\t" +
                            $"uuid={reader.GetString(1)}\tattempts={reader.GetInt32(5)}\t{reason}");
                    }
                }
            }

            if (rows == 0)
            {
                // Unknown or expired lease: the interface says to ignore it quietly. For
                // abandon, though, we need to know, otherwise we end up in the state
                // "I thought I had deleted it".
                if (reason is not null)
                    _drops.Write($"ABANDON\tlease {lid} not found (expired and returned?)\t{reason}");
                return;
            }

            using (var del = _write.CreateCommand())
            {
                del.CommandText = "DELETE FROM outbox WHERE lease_id = $lid;";
                del.Parameters.AddWithValue("$lid", lid);
                del.ExecuteNonQuery();
            }

            if (logLines is not null)
            {
                if (rows > MaxDropLogLines)
                    logLines.Add($"ABANDON\t… {rows - MaxDropLogLines} more rows, {rows} in total\t{reason}");

                _drops.WriteMany(logLines);
                _log($"⚠️ {rows} rows ({bytes / 1024.0:F0} KB) permanently dropped from the outbox: {reason}");
            }

            ClearWriteError();
            DeleteFiles(files);
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 0, null);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Transient failure: releases the lease, bumps attempts, sets notBefore.
    /// Careful: no <c>ct</c> is taken. If this did not run, the rows would stay stuck until
    /// the lease expires, so a cancelled shutdown token would delay the next retry.
    /// </summary>
    public async Task RetryAsync(Guid leaseId, DateTimeOffset notBefore, CancellationToken ct = default)
    {
        ThrowIfDisposed();
        if (leaseId == Guid.Empty) return;

        await _writeGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            using var cmd = _write.CreateCommand();
            cmd.CommandText = """
                UPDATE outbox
                   SET attempts = attempts + 1,
                       lease_id = NULL,
                       lease_expires_ms = NULL,
                       not_before_ms = $nb
                 WHERE lease_id = $lid;
                """;
            cmd.Parameters.AddWithValue("$lid", leaseId.ToString("D"));
            cmd.Parameters.AddWithValue("$nb", ToMs(notBefore));
            cmd.ExecuteNonQuery();
            ClearWriteError();
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 0, null);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Careful: <c>attempts</c> is deliberately not incremented here. An expired lease
    /// usually means the process died and restarted; the server said nothing.
    /// Incrementing attempts would start backoff right after a reboot, exactly when the
    /// accumulated backlog needs to go out quickly.
    /// </summary>
    public async Task<int> ReclaimExpiredLeasesAsync(DateTimeOffset now, CancellationToken ct = default)
    {
        ThrowIfDisposed();

        await _writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            using var cmd = _write.CreateCommand();
            cmd.CommandText = """
                UPDATE outbox
                   SET lease_id = NULL, lease_expires_ms = NULL
                 WHERE lease_id IS NOT NULL
                   AND (lease_expires_ms IS NULL OR lease_expires_ms <= $now);
                """;
            cmd.Parameters.AddWithValue("$now", ToMs(now));
            var n = cmd.ExecuteNonQuery();
            ClearWriteError();

            if (n > 0) _log($"outbox: {n} rows had expired leases, they were reclaimed");
            return n;
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 0, null);
            return 0;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Releases <b>all</b> leases at startup, whatever their expiry.
    ///
    /// Reasoning: only one agent runs per machine (SessionGuard binds to the console
    /// session), so every lease in the DB right now belongs to a <i>dead</i> process.
    /// Waiting for expiry would leave that batch stuck for 5 minutes after a reboot, for
    /// no benefit.
    ///
    /// Careful: even if the assumption is wrong (somehow two instances), the worst outcome
    /// is sending the same batch twice, which is harmless thanks to clientUuid.
    /// </summary>
    private void ReclaimAllLeases()
    {
        try
        {
            using var cmd = _write.CreateCommand();
            cmd.CommandText = "UPDATE outbox SET lease_id = NULL, lease_expires_ms = NULL WHERE lease_id IS NOT NULL;";
            var n = cmd.ExecuteNonQuery();
            if (n > 0) _log($"outbox: {n} rows leased by the previous run were reclaimed");
        }
        catch (SqliteException ex)
        {
            _log($"⚠️ outbox: could not reclaim the old leases — {ex.Message}");
        }
    }

    /// <summary>
    /// Deletes rows whose <c>kind</c> this build does not recognize.
    ///
    /// This is only possible after a downgrade (a newer agent wrote a new kind of row, then an
    /// older agent started). If kept, those rows would never get leased and would not show up
    /// in the <see cref="OutboxBudget"/> survey either, so they would occupy space that no rule
    /// would ever reclaim. They are written to the drop log, so at least it is not silent.
    /// </summary>
    private void PurgeUnknownKinds()
    {
        var known = string.Join(", ", Enum.GetNames<OutboundKind>().Select(n => $"'{n}'"));

        try
        {
            var files = new List<string>();
            var kinds = new List<string>();

            using (var sel = _write.CreateCommand())
            {
                sel.CommandText = $"SELECT row_id, kind, file_path FROM outbox WHERE kind NOT IN ({known});";
                using var reader = sel.ExecuteReader();
                while (reader.Read())
                {
                    kinds.Add(reader.GetString(1));
                    if (!reader.IsDBNull(2)) files.Add(reader.GetString(2));
                }
            }

            if (kinds.Count == 0) return;

            using (var del = _write.CreateCommand())
            {
                del.CommandText = $"DELETE FROM outbox WHERE kind NOT IN ({known});";
                del.ExecuteNonQuery();
            }

            DeleteFiles(files);

            var distinct = string.Join(",", kinds.Distinct());
            var line = $"UNKNOWN-KIND\t{kinds.Count} rows were deleted (kinds: {distinct}) — " +
                       "the agent was probably downgraded";
            _drops.Write(line);
            _log("⚠️ " + line);
        }
        catch (SqliteException ex)
        {
            _log($"⚠️ outbox: could not clear the rows of unknown kind — {ex.Message}");
        }
    }

    // ── survey and depth (read connection) ──────────────────────────────────

    public async Task<OutboxDepth> GetDepthAsync(CancellationToken ct = default)
    {
        if (_disposed) return OutboxDepth.Empty;

        await _readGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return ReadDepth(_read);
        }
        catch (SqliteException ex)
        {
            // For the tray, not getting the depth only means an empty tooltip; it is not a
            // reason to stop tracking.
            _log($"⚠️ could not read the outbox depth — {ex.Message}");
            return OutboxDepth.Empty;
        }
        finally
        {
            _readGate.Release();
        }
    }

    /// <summary>
    /// One GROUP BY pass; no need to run four separate COUNTs.
    /// Leased rows are counted too: they have not reached the server yet, so they must be
    /// part of the "how much is left" figure.
    /// </summary>
    private static OutboxDepth ReadDepth(SqliteConnection conn)
    {
        int segments = 0, appUsage = 0, events = 0, screenshots = 0;
        var bytes = 0L;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT kind, COUNT(*), COALESCE(SUM(size_bytes), 0) FROM outbox GROUP BY kind;";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var count = reader.GetInt32(1);
            bytes += reader.GetInt64(2);

            if (!TryParseKind(reader.GetString(0), out var kind)) continue;

            switch (kind)
            {
                case OutboundKind.Segment: segments += count; break;
                case OutboundKind.AppUsage: appUsage += count; break;
                case OutboundKind.Event: events += count; break;
                case OutboundKind.Screenshot: screenshots += count; break;
            }
        }

        return new OutboxDepth(segments, appUsage, events, screenshots, bytes);
    }

    /// <summary>
    /// A light survey of the whole outbox. Careful: the payload is not fetched; loading the
    /// JSON of a hundred thousand rows from a machine that was offline for a week would
    /// cause an OOM just while trimming.
    /// </summary>
    public async Task<IReadOnlyList<OutboxEntryInfo>> SurveyAsync(CancellationToken ct = default)
    {
        if (_disposed) return [];

        await _readGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var list = new List<OutboxEntryInfo>();

            using var cmd = _read.CreateCommand();
            cmd.CommandText = """
                SELECT row_id, kind, enqueued_at_ms, size_bytes, (lease_id IS NOT NULL)
                FROM outbox ORDER BY row_id;
                """;

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                if (!TryParseKind(reader.GetString(1), out var kind)) continue;

                list.Add(new OutboxEntryInfo(
                    reader.GetInt64(0),
                    kind,
                    FromMs(reader.GetInt64(2)),
                    reader.GetInt64(3),
                    reader.GetInt64(4) != 0));
            }

            return list;
        }
        catch (SqliteException ex)
        {
            _log($"⚠️ the outbox survey failed — {ex.Message}");
            return [];
        }
        finally
        {
            _readGate.Release();
        }
    }

    // ── trimming ────────────────────────────────────────────────────────────

    /// <summary>
    /// Carries out the decisions of <see cref="OutboxBudget.Plan"/>.
    ///
    /// Careful: <c>AND lease_id IS NULL</c> on every DELETE. Between the survey and the
    /// delete the sync worker may lease that row, and removing the .webp from under it would
    /// break the upload in progress.
    /// </summary>
    public async Task<int> EvictAsync(IReadOnlyList<long> rowIds, string reason, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(rowIds);
        ThrowIfDisposed();
        if (rowIds.Count == 0) return 0;

        await _writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var files = new List<string>();
            var logLines = new List<string>();
            var deleted = 0;
            var bytes = 0L;

            using (var tx = _write.BeginTransaction())
            {
                using var sel = _write.CreateCommand();
                sel.Transaction = tx;
                sel.CommandText = """
                    SELECT kind, client_uuid, file_path, size_bytes
                    FROM outbox WHERE row_id = $id AND lease_id IS NULL;
                    """;
                var pSel = sel.Parameters.AddWithValue("$id", 0L);

                using var del = _write.CreateCommand();
                del.Transaction = tx;
                del.CommandText = "DELETE FROM outbox WHERE row_id = $id AND lease_id IS NULL;";
                var pDel = del.Parameters.AddWithValue("$id", 0L);

                foreach (var rowId in rowIds)
                {
                    pSel.Value = rowId;

                    string kind, uuid;
                    string? file = null;
                    long size;

                    using (var reader = sel.ExecuteReader())
                    {
                        if (!reader.Read()) continue;   // gone, or just leased

                        kind = reader.GetString(0);
                        uuid = reader.GetString(1);
                        if (!reader.IsDBNull(2)) file = reader.GetString(2);
                        size = reader.GetInt64(3);
                    }

                    pDel.Value = rowId;

                    // Careful: count after the DELETE. If the row got leased between the
                    // SELECT and the DELETE, the DELETE returns 0, and counting those bytes
                    // as "freed" would skew the budget accounting.
                    if (del.ExecuteNonQuery() == 0) continue;

                    deleted++;
                    bytes += size;
                    if (file is not null) files.Add(file);

                    if (logLines.Count < MaxDropLogLines)
                        logLines.Add($"EVICT\t{kind}\trow={rowId}\tuuid={uuid}\tbytes={size}\t{reason}");
                }

                tx.Commit();
            }

            ClearWriteError();

            if (deleted == 0) return 0;

            if (deleted > MaxDropLogLines)
                logLines.Add($"EVICT\t… {deleted - MaxDropLogLines} more rows, {deleted} in total\t{reason}");

            _drops.WriteMany(logLines);
            _log($"⚠️ outbox trim: {deleted} rows, {bytes / 1024.0 / 1024.0:F1} MB — {reason}");

            DeleteFiles(files);
            Paths.PruneEmptyScreenshotFolders();
            MaybeIncrementalVacuum();

            return deleted;
        }
        catch (SqliteException ex)
        {
            NoteWriteFailure(ex, 0, null);
            return 0;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Survey, then <see cref="OutboxBudget.Plan"/>, then trim, in one call. The sync worker
    /// calls only this (once at startup, then hourly, and immediately whenever
    /// <see cref="LastWriteError"/> appears).
    ///
    /// The two lists are passed to <see cref="EvictAsync"/> separately on purpose: with
    /// "dropped for age" and "dropped for lack of space" shown separately in the drop log, you
    /// can tell whether retention or the disk needs increasing.
    ///
    /// Careful: the accounting only uses <c>size_bytes</c> of rows in the queue. Orphaned
    /// .webp files on disk are not counted; <see cref="SweepOrphanFilesAsync"/> is
    /// responsible for those.
    /// </summary>
    public async Task<EvictionPlan> EnforceBudgetAsync(
        OutboxBudget budget, DateTimeOffset now, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(budget);
        if (_disposed) return EvictionPlan.Nothing(0);

        var survey = await SurveyAsync(ct).ConfigureAwait(false);
        var plan = budget.Plan(survey, now);
        if (plan.IsEmpty) return plan;

        if (plan.ExpiredRowIds.Count > 0)
        {
            await EvictAsync(plan.ExpiredRowIds, "past the age limit", ct).ConfigureAwait(false);
        }

        if (plan.OverBudgetRowIds.Count > 0)
        {
            var capMb = budget.CapBytes / 1024 / 1024;
            await EvictAsync(plan.OverBudgetRowIds, $"over the disk budget ({capMb} MB)", ct)
                .ConfigureAwait(false);
        }

        return plan;
    }

    /// <summary>
    /// Careful: after trimming, SQLite does not shrink the file by itself; freed pages stay
    /// inside. Because auto_vacuum=INCREMENTAL is set, we can hand them back to the OS now
    /// and then. A full <c>VACUUM</c> is deliberately not called: it makes a copy of the
    /// whole DB (so it would fail on a full disk exactly when it is needed most) and locks
    /// the database throughout.
    /// </summary>
    private void MaybeIncrementalVacuum()
    {
        if (++_evictionsSinceVacuum < 10) return;
        _evictionsSinceVacuum = 0;

        try
        {
            using var cmd = _write.CreateCommand();
            cmd.CommandText = "PRAGMA incremental_vacuum(1000);";
            cmd.ExecuteNonQuery();
        }
        catch (SqliteException)
        {
            // With auto_vacuum=NONE this is just a no-op/error; no harm.
        }
    }

    // ── orphan files ────────────────────────────────────────────────────────

    /// <summary>
    /// Deletes .webp files on disk that have no row. Returns how many were removed.
    ///
    /// They arise in two ways: (a) the process dies between the ack commit and the file
    /// deletion, (b) a screenshot was written but the process died before the row was
    /// inserted. Both are rare, but orphaned files are <b>not counted in any budget</b>, so
    /// this is a leak that could go on for months without anyone noticing.
    ///
    /// Careful: must not be run without <paramref name="grace"/>: the capture module writes
    /// the file and then enqueues; sweeping in those few milliseconds would delete the
    /// screenshot just taken.
    /// </summary>
    public async Task<int> SweepOrphanFilesAsync(
        DateTimeOffset now, TimeSpan? grace = null, CancellationToken ct = default)
    {
        if (_disposed) return 0;
        var cutoff = (now - (grace ?? TimeSpan.FromHours(1))).UtcDateTime;

        HashSet<string> known;
        await _readGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using var cmd = _read.CreateCommand();
            cmd.CommandText = "SELECT file_path FROM outbox WHERE file_path IS NOT NULL;";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var known1 = reader.GetString(0);
                known.Add(NormalizePath(known1));
                // Careful: thumbnails are `*.webp` too; without marking them as known the
                // sweeper would treat every thumbnail as an orphan and delete it, and nobody
                // would understand why the gallery suddenly became slow again.
                known.Add(NormalizePath(OutboxPaths.ThumbPathFor(known1)));
            }
        }
        catch (SqliteException ex)
        {
            _log($"⚠️ outbox: could not sweep the orphan files — {ex.Message}");
            return 0;
        }
        finally
        {
            _readGate.Release();
        }

        var removed = 0;
        var freed = 0L;

        try
        {
            foreach (var file in Directory.EnumerateFiles(Paths.ScreenshotQueue, "*.webp", SearchOption.AllDirectories))
            {
                ct.ThrowIfCancellationRequested();

                try
                {
                    var info = new FileInfo(file);
                    if (info.LastWriteTimeUtc > cutoff) continue;
                    if (known.Contains(NormalizePath(file))) continue;

                    var size = info.Length;
                    File.Delete(file);
                    removed++;
                    freed += size;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (DirectoryNotFoundException) { }
        catch (UnauthorizedAccessException) { }

        if (removed > 0)
        {
            Paths.PruneEmptyScreenshotFolders();
            _log($"outbox: {removed} orphan .webp files deleted ({freed / 1024.0 / 1024.0:F1} MB reclaimed)");
        }

        return removed;
    }

    // ── closing ─────────────────────────────────────────────────────────────

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        await _writeGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            // Careful: a TRUNCATE checkpoint writes everything in the WAL into the main file
            // and resets the WAL to zero. Without it the next startup would have to run
            // recovery (safe, but slow), and if backup software copies only the .db, the last
            // few days of rows left in the WAL would not be in the backup.
            using var cmd = _write.CreateCommand();
            cmd.CommandText = "PRAGMA wal_checkpoint(TRUNCATE);";
            cmd.ExecuteNonQuery();
        }
        catch (SqliteException)
        {
            // Nothing to do if this fails at close; the data is already committed.
        }
        finally
        {
            _writeGate.Release();
        }

        _read.Dispose();
        _write.Dispose();
        _writeGate.Dispose();
        _readGate.Dispose();
    }

    // ── small helpers ───────────────────────────────────────────────────────

    private long LastRowId()
    {
        using var cmd = _write.CreateCommand();
        cmd.CommandText = "SELECT last_insert_rowid();";
        return Convert.ToInt64(cmd.ExecuteScalar() ?? 0L);
    }

    private long FindRowIdByUuid(Guid uuid)
    {
        using var cmd = _write.CreateCommand();
        cmd.CommandText = "SELECT row_id FROM outbox WHERE client_uuid = $uuid;";
        cmd.Parameters.AddWithValue("$uuid", uuid.ToString("D"));
        var value = cmd.ExecuteScalar();
        return value is null or DBNull ? -1 : Convert.ToInt64(value);
    }

    private static void AddInsertParameters(SqliteCommand cmd, OutboxItem item)
    {
        cmd.Parameters.AddWithValue("$uuid", item.ClientUuid.ToString("D"));
        cmd.Parameters.AddWithValue("$kind", item.Kind.ToString());
        cmd.Parameters.AddWithValue("$at", ToMs(item.EnqueuedAt));
        cmd.Parameters.AddWithValue("$payload", item.Payload);
        cmd.Parameters.AddWithValue("$file", (object?)item.FilePath ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$size", item.SizeBytes);
    }

    /// <summary>
    /// The .webp after its row is gone. Careful: failures are swallowed: if AV or an indexer
    /// holds the file it cannot be deleted, but the row is already gone, and throwing here
    /// would break the whole ack/evict path. Whatever is left behind,
    /// <see cref="SweepOrphanFilesAsync"/> picks up later.
    /// </summary>
    private void DeleteFiles(List<string> files)
    {
        foreach (var file in files)
        {
            try
            {
                File.Delete(file);   // does not throw if it does not exist
                // Also its thumbnail, otherwise those would pile up forever
                File.Delete(OutboxPaths.ThumbPathFor(file));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>
    /// A write failed, usually a full disk (SQLITE_FULL) or an ACL problem (SQLITE_READONLY).
    ///
    /// Careful: exceptions are <b>not</b> propagated from here. The tracking thread enqueues
    /// every minute; throwing from there would kill the thread and the machine would quietly
    /// stop counting anything. Instead: this second's record is lost (sad, but bounded),
    /// <see cref="LastWriteError"/> is set so the tray shows "Degraded", and the sync worker
    /// can see it and run a budget trim to make room.
    ///
    /// The log is throttled too: if the failure is caused by a full disk, writing one log
    /// line per second would make the problem worse.
    /// </summary>
    private void NoteWriteFailure(SqliteException ex, int lostItems, OutboundKind? kind)
    {
        LastWriteError = $"SQLite {ex.SqliteErrorCode}: {ex.Message}";
        LastWriteErrorAt = DateTimeOffset.UtcNow;

        var now = DateTimeOffset.UtcNow;
        if (now - _lastWriteErrorLoggedAt < ErrorLogWindow) return;
        _lastWriteErrorLoggedAt = now;

        var free = TryGetFreeBytes(Paths.Root);
        var freeText = free is null ? "?" : $"{free.Value / 1024.0 / 1024.0:F0} MB";

        var line = $"WRITE-FAIL\t{kind?.ToString() ?? "-"}\tlost≈{lostItems}\tfree={freeText}\t{LastWriteError}";
        _drops.Write(line);
        _log($"⚠️ the outbox cannot write (free space {freeText}) — {LastWriteError}");
    }

    private void ClearWriteError()
    {
        if (LastWriteError is null) return;
        LastWriteError = null;
        LastWriteErrorAt = null;
        _log("outbox: writing works again");
    }

    private static long? TryGetFreeBytes(string path)
    {
        try
        {
            return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Careful: <c>Enum.TryParse</c> also accepts numbers; "0" would silently become
    /// <see cref="OutboundKind.Segment"/>. We always write the name, so a first character
    /// that is a digit means corrupt data, and turning it into a segment would send garbage
    /// to the wrong endpoint.
    /// </summary>
    private static bool TryParseKind(string text, out OutboundKind kind)
    {
        kind = default;
        if (string.IsNullOrEmpty(text) || !char.IsLetter(text[0])) return false;
        return Enum.TryParse(text, ignoreCase: false, out kind);
    }

    private static Guid ParseGuid(string text) => Guid.TryParse(text, out var g) ? g : Guid.Empty;

    private static string NormalizePath(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch (Exception)
        {
            return path;
        }
    }

    /// <summary>
    /// Careful: unix ms, in UTC. The DateTimeOffset's offset is lost; that is deliberate.
    /// Both the row-age calculation and the <c>not_before</c> comparison want an exact UTC
    /// instant; the real timestamp (with offset) stays in the payload JSON, and that is what
    /// goes to the server.
    /// </summary>
    private static long ToMs(DateTimeOffset value) => value.ToUnixTimeMilliseconds();

    private static DateTimeOffset FromMs(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms);

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(SqliteOutboxStore));
    }
}
