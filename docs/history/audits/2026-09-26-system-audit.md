# System audit — 26 September 2026

> This is the original pre-fix audit. Follow-up repairs and current validation are in the [fix tracker](2026-09-26-fix-tracker.md).

Scope: current local workspace, isolated backend tests, Windows agent build/tests,
frontend tests and failure simulation, and read-only production checks at hub.oxeio.com.
No application fixes, production writes, deployment or GitHub push were performed.

## Findings

### A01 · P1 · The local backend cannot compile

Nine canonical source files under `server/src/summary` and `server/src/targets`
are absent; their implementations have `(1)` filenames. Imports still request
`summary.math`, `summary.service`, `targets.service`, `targets.module`, etc.
Example: [app.module.ts](../../oxeio-monitor/server/src/app.module.ts#L23).

**Observed:** `npm run typecheck` fails with module-not-found errors and cascading
type errors. `test:nodb` has 13 failed suites, 38 passed; 844 tests pass and one is
skipped. This is a local build blocker, not evidence that the running API is down.

**Isolation:** copied current server source/tests to an audit directory and
normalized only these filenames there. Typecheck and source ESLint then pass;
all 51 no-DB suites pass (1,230 tests passed, one skipped). Original files were
preserved. Restore canonical names while retaining any local edits before the
next backend build.

### A02 · P1 · Concurrent completions exceed the daily design cap

Source: `server/src/targets/targets(1).service.ts:838–860`, `markDone`.

The service reads today's count, compares it with the cap, then updates the target
in a separate statement. There is no employee/day lock or transaction covering
that decision. With 24 completed designs and a cap of 25, two different target
completion requests can both read 24 and both succeed.

**Reproduction:** a deterministic test invokes the actual service twice, holds
both count reads until they overlap, and then releases them. Final count: **26**,
expected at most 25. Prisma dependencies are mocked; this proves the service
interleaving, not that a specific production employee has already exceeded the cap.

**Fix direction:** serialize the count/check/update per employee and work date
inside a database transaction; retain a concurrent integration regression test.

### A03 · P1 · A concurrent delete can remove just-completed work from the active workflow

Source: `server/src/targets/targets(1).service.ts:1535–1556`, `softDelete`.

The initial read excludes `done` rows in JavaScript. The final `updateMany` filters
only by the selected IDs. If a designer completes a selected row between that
read and update, the update still changes its status to `deleted`.

**Reproduction:** actual service, simulated completion immediately after the
selection read: final status **deleted**, expected **done**. This is a soft delete,
not physical record loss, but it violates the service's protection for completed
work and can remove it from status-filtered queues.

**Fix direction:** enforce eligible statuses in the write predicate, and compute
returned counts/audit metadata from the rows actually changed.

### A04 · P2 · Returning a design to the pool leaves the old production stages attached

Source: `server/src/targets/targets(1).service.ts:1456–1488`, `update`.

The `pool` transition clears assignment/completion/review fields but leaves
`checkedAt`, `checkedById`, `errorFoundAt`, `fixedAt`, `fixedById`, `uploadedAt`,
`liveAt` and `liveAsin`. A reassigned design can therefore still look checked,
uploaded or live from its previous pass and miss queues that require null stage
fields.

**Reproduction:** return a completed/uploaded/live sample row to the pool via the
actual service. Its previous upload date survives; the reset invariant fails.

**Fix direction:** either reject returning a progressed design until its stages
are explicitly undone, or atomically reset the dependent stages with an audit
record. Preserve history separately if previous-stage history is required.

### A05 · P2 · Repeating a generic Done request rewrites completion history

Source: `server/src/targets/targets(1).service.ts:1486–1492`, `update`.

`PATCH /design-targets/:id` with `status: done` unconditionally sets `completedAt`
to now and `completedById` to the latest caller, including already-done rows.
A retry or stale browser tab can move work from one day's count to another.

**Reproduction:** sample row completed September 24; repeat Done September 26.
The service changes the stored completion date to **September 26**.

**Fix direction:** preserve completion metadata when the row is already done;
validate legal transitions and handle intentional corrections through an audited
operation. This concerns the generic status endpoint, not the guarded personal
`markDone` transition.

### A06 · P2 · Temporary auth API failure is displayed as a sign-in requirement

Source: `web/src/auth/AuthContext.tsx:75–78`.

`refresh()` clears the user for every `ApiError`, including HTTP 500/502/503.
Those responses do not establish that the user's session expired. During a brief
API/reverse-proxy outage, the app shows the sign-in form instead of a service
error and retry action. The same branch affects refresh after an online event.

**Browser reproduction:** isolated built dashboard with only `/auth/me` returning
HTTP 503 rendered **Sign in**, with no outage explanation. No production login or
credentials were used. Screenshot saved in the conversation's visualization
folder as `audit-auth503.png`.

**Fix direction:** clear authentication only for authentication failures such as
401; preserve/mark unknown session state for transient server failures and offer
retry. Include 401, 503 and network-failure UI tests.

### A07 · P1 · Deployed frontend is ahead of the deployable source checkout

Production frontend is build **406 / 3adb378**. API and VPS checkout are
**404 / a763b1c**. The new frontend was deployed directly from compiled assets;
its source commits have not been pushed/synchronized. This is documented in
[studio-deployment.md](../studio-deployment.md).

**Observed:** live API reports 404/a763b1c; read-only VPS Git inspection reports
a763b1c. The standard update script builds from that checkout. Rebuilding web
from it before source synchronization can replace Studio with the older UI.
The version badge also continues to report the mismatch.

**Fix direction:** synchronize the reviewed local commits into the authorized
source/deployment workflow, then make frontend/backend release provenance clear.
GitHub push was not attempted during this audit. A version mismatch alone does
not prove API incompatibility.

## Evidence and checks

| Area | Result |
|---|---|
| Frontend | Typecheck, ESLint, 256 tests pass; production build passed in immediately preceding deployment |
| Backend as found | Typecheck fails; 13 no-DB suites fail to import |
| Backend with filenames normalized in isolated copy | Typecheck and source ESLint pass; 1,230 tests pass, one skipped |
| New targeted reproductions | Four expected-invariant tests fail, demonstrating A02–A05 |
| Windows Core | 403 tests pass |
| Windows Agent | 130 tests pass |
| Agent solution, including watchdog | Build passes, zero warnings/errors |
| Live services | Web/API/Postgres healthy; API restart count 0 |
| Disk and memory | Disk 22% used; about 6.9 GB memory available at check time |
| Anonymous API probes | live, employees, screenshots, design-targets return 401 |
| Backup metadata | Latest observed local backup September 25 20:30 UTC, about 22 MB |
| Offsite backup service | Timer active; last service result success, exit 0, September 26 04:03:48 UTC |

The target service file tested has Git blob `2ce95cfe5f128da7b79fd0e9b24b6cd9d153e79c`,
identical to the service at the deployed API source revision a763b1c. The new
reproductions use the real service with in-memory Prisma substitutes, not live
staff records. They do not establish whether the affected races occurred in
production.

The inactive GlobalSearch component is an intentional, documented product
choice (G127/E14), so it is not reported as a new bug.

## Reproduce the target-service findings

See [target-lifecycle-repro.spec.ts.txt](target-lifecycle-repro.spec.ts.txt).
Copy it into `server/test/audit-regressions.spec.ts` in an isolated checkout with
the canonical filenames restored, then run:

```powershell
npx vitest run --config vitest.nodb.config.ts test/audit-regressions.spec.ts
```

Four failures are expected until the corresponding bugs are fixed. The tests
are audit evidence, not added to the application's normal test suite.

## Limits

This is a broad engineering audit, not a claim that every path is bug-free.
Database integration/e2e tests were not run: no local PostgreSQL or Docker runtime
was available, and the live database was not used as a test database. No real
staff account, role-changing operation, payroll adjustment, target mutation,
screenshot capture, agent update rollout or backup restore was exercised in
production. Offsite service success is not a restore-integrity test. Individual
office PCs still need device-level verification. These limits remain even though
the existing unit suites pass.
