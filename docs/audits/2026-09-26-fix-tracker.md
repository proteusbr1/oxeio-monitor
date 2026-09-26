# System audit fixes â€” 26 September 2026

The owner authorized documenting and fixing A01â€“A07 one by one.
Original evidence: [system audit](2026-09-26-system-audit.md).

| ID | Priority | Issue | Status |
|---|---|---|---|
| A01 | P1 | Canonical filenames break backend imports | Fixed; backend typecheck passes |
| A02 | P1 | Concurrent completion exceeds the daily cap | Fixed; 19 quota integration tests pass, including concurrent requests |
| A03 | P1 | Concurrent delete changes completed work to deleted | Fixed; real PostgreSQL regression passes |
| A04 | P2 | Pool reset preserves old upload/live stages | Fixed; real PostgreSQL regression passes |
| A05 | P2 | Repeated Done rewrites completion history | Fixed; real PostgreSQL regression passes |
| A06 | P2 | Transient auth failure shows Sign in | Fixed; 8 regressions pass, browser 503/retry and 401 verified |
| A07 | P1 | Live release and deployment source differ | Deployment guard implemented; matched VPS deployment pending |

## Verification and release

Results will be recorded after each fix. Database integration checks and live
deployment are tracked separately from local unit tests. GitHub source push is
not assumed from the earlier VPS deployment authorization.

- Backend typecheck, ESLint and build pass after fixes. No-DB tests: 1,230 pass, one skipped.
- Frontend build and ESLint pass; 264 tests pass. Existing Vite bundle-size warning remains.
- A02: 19 real PostgreSQL quota tests pass; existing administrative override remains valid.
- Disposable database is isolated on VPS localhost port 55432 and reached through an SSH tunnel. No production database is used for tests.

- A03–A05: 82 existing target integration tests plus 3 new lifecycle regressions pass. Combined with quota coverage: **104 integration tests passed**.
- A03 regression observes PostgreSQL waiting on a row lock before committing completion; deletion then preserves the completed row.
- All ten primary docs, root/deployment README, Studio notes and dated audit/fix records have been updated. Pre-existing documentation edits were retained.
- A07 guard prevents rebuilding behind the last verified source marker and rejects a healthy API with the wrong commit.
