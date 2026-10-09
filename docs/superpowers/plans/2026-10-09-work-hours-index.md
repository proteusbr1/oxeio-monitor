# Work hours, schedule compliance and the hours statement — plan index

**Spec:** `docs/superpowers/specs/2026-10-09-work-hours-and-pay-period-design.md`

The spec has four deliveries. Each one has its own plan, ships on its own
(tests green, deployable, nothing changes until switched on) and is merged
into `pericialmed` separately. Do them in this order — each later plan
relies on names the earlier ones create.

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | `2026-10-09-d1-mail-foundation.md` | `mail/` module, SMTP on screen with test email, recipients per kind, server-side email language | — |
| 2 | `2026-10-09-d2-presence-measure.md` | "presence" hours measure per policy | — |
| 3 | `2026-10-09-d3-schedule-compliance.md` | enforced schedule, breaches table, Schedule screen, digest block | 2 (presence blocks) |
| 4 | `2026-10-09-d4-hours-statement.md` | pay periods with cutoff, ledger, `finance` role, hourly job + email, Hours statement screen | 1, 2 |

## Working rules for every plan

- Branch: one branch per delivery off the current `pericialmed`
  (`feat/mail-foundation`, `feat/presence-measure`,
  `feat/schedule-compliance`, `feat/hours-statement`). Merge into
  `pericialmed` only with **all** suites green (server, web, agent Core,
  Docker build) — every push to `pericialmed` deploys to production.
- Server tests need the local test database (see `oxeio-monitor/.env`; the
  container is `oxeio-test-pg2` on port 55432). Before switching between
  branches whose migrations differ, drop the `oxeio_test` database.
- Commands (run from the folder named):
  - server, one file: `npm test -- test/<file>.spec.ts` (in `oxeio-monitor/server`)
  - server, all: `npm test`, then `npm run typecheck` and `npm run lint`
  - web, all: `npm test`, `npm run typecheck`, `npm run lint` (in `oxeio-monitor/web`)
- Everything generic: no company, country, statute or payroll-product name in
  code, comments, screen text, emails or tests. New behaviour off or neutral
  by default. English in code; screen and email text translated in
  `en` / `pt-BR` / `es`.
- New tables go into the `TRUNCATE` list of `resetDatabase()` in
  `server/test/setup/harness.ts` in the same task that creates them.
- Old migrations are never edited. New migration folders are written by
  hand (SQL) and applied by the test setup (`prisma migrate deploy`); run
  `npx prisma generate` after editing `schema.prisma`.
- `docs/ARCHITECTURE.md` is updated in the same commit that adds or moves a
  module.
- Never run `prettier --write` on whole folders; format only the files you
  touched.
- Commit messages in English, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Production settings after all four ship (on screen, not in code)

- Hourly and fixed-schedule policies: measure = presence, gap 15 min.
- Fixed-schedule policy: schedule enforced, office hours and break as
  contracted, break window, tolerance 5 per mark / 10 per day.
- Hours statement: cutoff day 25, send time 07:00.
- A `finance` login for the finance employee.
- SMTP: Amazon SES (`email-smtp.<region>.amazonaws.com`, port 587), then
  "Send test email".
