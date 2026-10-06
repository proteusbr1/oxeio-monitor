# oXeio — architecture map

Where things live and how they fit, for whoever maintains this fork. Kept up
to date with the code: a change that moves something updates this file in the
same commit.

## The three programs

| Program | Folder | Stack | Runs on |
|---|---|---|---|
| **API** | `oxeio-monitor/server` | NestJS 11, Prisma 6, PostgreSQL 16 | the server (Docker) |
| **Dashboard** | `oxeio-monitor/web` | React 19, Vite 7, Tailwind 4 | the browser, served by Caddy |
| **Agent** | `oxeio-monitor/agent` | .NET 8, WinForms tray app + watchdog | each Windows PC |

The agent records activity and screenshots and sends them to the API; the
dashboard reads everything through the API (`/api/v1/...`). The API is the
only thing that talks to the database.

## Production (pericialmed)

- Branch **`pericialmed`** is production: every push deploys through Coolify
  (`docker-compose.coolify.yml`, `coolify/` — owned by the infra side, do not
  edit or delete). `main` mirrors it.
- `GET /api/v1/health` reports the deployed `commit`.
- Screenshots live in a Backblaze B2 bucket; the database is backed up by
  Databasus (`BACKUP_MODE=external`).
- New environment variables are registered in Coolify by the infra side.

## Settings: screen first, then the environment

Most configuration can be changed on **Settings** in the dashboard. Each
setting is resolved on its own: a value saved on screen (table `settings`,
key/value JSON) wins; otherwise the environment variable; otherwise the
built-in default. The screen shows where each value comes from.

| Screen | `settings` key | Overrides env |
|---|---|---|
| Settings → Region | `region` | `WORK_TIMEZONE`, `CURRENCY`, `DISPLAY_LOCALE` |
| Settings → Storage & backup | `storage`, `ops.backup`, `ops.offsite` | `STORAGE_DRIVER`, `S3_*`, `BACKUP_MODE`, `B2_*` |
| Settings → Notifications | `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Settings → Error reporting | `errorReporting` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_BROWSER`, `SENTRY_LOG_ERRORS` |
| Settings → Agent updates | `agent.updateKey` | `AGENT_UPDATE_PUBLIC_KEY` |
| Settings → Modules | `features` | — (screen only) |

Server side: `server/src/settings/app-settings.service.ts` reads them (cached,
cleared on save); each subject has a `resolve…()` rule next to it.

## Modules that can be switched off

Settings → Modules (`server/src/features/`). All on by default. Off hides the
screens and makes the endpoints answer 404 (`@RequiresFeature(...)`); nothing
is deleted.

| Key | Module |
|---|---|
| `payroll` | pay sheet and salaries (the Payroll page becomes "Leave & months") |
| `deposits` | security deposits; payroll stops holding them back |
| `designTargets` | design target pool, review, hand-out jobs, digest lines |
| `staffScreenshots` | staff and researcher logins see their own screenshots |

## Roles

`owner` (everything), `manager` (team, reports, screenshots — no money, no
system settings), `researcher` (adds design targets; own data only),
`employee` (own data only). Roles are checked on the server (`@Roles(...)`
and per-service scope rules); the dashboard only hides what a role cannot use.

## API — `oxeio-monitor/server/src`

| Folder | What it does |
|---|---|
| `agent/` | everything the Windows agent calls: enrolment, config, heartbeat, activity and screenshot ingest, updates and their gradual rollout, capability health |
| `activity/` | app/site usage and the categories they fall into |
| `summary/` | daily and monthly roll-ups (hours, targets, pace), day close, retention of old screenshots |
| `dashboard/` | the Live Board: team status, pulse, 7-day trend |
| `screenshots/` | the gallery and signed image links (who may see whose) |
| `reports/` | attendance / summary / apps reports, Excel and PDF, the monthly report delivery |
| `payroll/` | the pay sheet, currency |
| `deposits/` | security deposits ledger and settlements |
| `targets/` | design targets: pool, hand-out jobs, review, file trace |
| `adjustments/` | hour corrections made by the owner |
| `admin/` | staff (employees), holidays, leave, month closing, work policies, devices, agent versions, audit log |
| `users/` | portal logins |
| `me/` | "My data" for the signed-in person |
| `auth/` | login, sessions (JWT cookie + CSRF), 2FA, role guard |
| `alerts/` | alert rules (agent down, tamper, no activity, disk, backup), dispatch to email / Telegram / Teams |
| `digest/` | daily and weekly summaries |
| `ops/` | the server's own backup, offsite copy, health |
| `settings/` | dashboard-editable settings (see above) |
| `features/` | module switches (see above) |
| `error-reporting/` | Sentry |
| `storage/` | where screenshots are stored: local disk or S3/B2 |
| `audit/` | the audit log writer |
| `health/` | `GET /health` |
| `prisma/`, `common/`, `scripts/` | database client, shared helpers, one-off scripts |

Database schema and migrations: `server/prisma/`. Seed and holiday data:
`server/prisma/seed.ts`, `holiday-sets.ts`.

## Dashboard — `oxeio-monitor/web/src`

| Folder | What it holds |
|---|---|
| `api/` | one file per subject, typed calls to the API |
| `auth/`, `features/` | session and module-switch contexts |
| `components/` | layout, tables, cards and other shared pieces |
| `lib/` | formatting (time zone, currency, locale), downloads, crash reports |
| `pages/` | one page per menu item; bigger pages have a folder (`live/`, `payroll/`, `settings/`, `reports/`, …) |

The menu is built in `components/Layout.tsx` (roles and module switches per
item); routes are in `App.tsx`.

## Agent — `oxeio-monitor/agent`

| Project | What it holds |
|---|---|
| `src/oXeio.Core` | platform-free logic (time, tracking, capture rules) — builds and tests on Linux |
| `src/oXeio.Agent` | the Windows tray app: capture, sync, local outbox, UI |
| `src/oXeio.Watchdog` | restarts the agent; installed as a logon task |
| `installer/` | WiX MSI (`build.ps1`) |
| `tests/` | xUnit tests for both |

Build options are fixed in the MSI: `build.ps1 -ServerUrl … -UpdatePublicKey …
-HideLatestShot`.

## Tests

| Where | Command | Needs |
|---|---|---|
| server | `npm test` in `server/` | PostgreSQL (see `.env`); `S3_TEST_ENDPOINT` for the S3 test |
| web | `npm test` in `web/` | nothing |
| agent | `dotnet test` (Core runs anywhere; Agent needs Windows) | — |

CI (`.github/workflows/ci.yml`) runs all of them plus the Docker builds. The
MSI job fails because WiX v7 needs its EULA accepted — a known CI issue, not
a code problem.

## Docs

Product decisions and history from the original project are in `docs/`
(in Bengali, as the original author wrote them).
