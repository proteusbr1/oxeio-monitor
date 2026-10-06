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

## First run

An install without an owner shows a **setup wizard** instead of the login
(`server/src/setup/`, `web/src/pages/setup/`): company name and country, time
zone, currency and formats, the owner's account, the work week. It creates the
owner, the default work policy and app categories, imports the country's
public holidays (this year and next), and restarts the server if the time
zone changed. The wizard link carries a one-time token printed in the server
log at start (`SETUP_TOKEN` to set your own), so a stranger cannot claim a
fresh install. New installs start with the design-target and deposit modules
off. The CLI seed (`server/prisma/seed.ts`) still works for scripted installs.

## Settings: screen first, then the environment

Most configuration can be changed on **Settings** in the dashboard. Each
setting is resolved on its own: a value saved on screen (table `settings`,
key/value JSON) wins; otherwise the environment variable; otherwise the
built-in default. The screen shows where each value comes from.

| Screen | `settings` key | Overrides env |
|---|---|---|
| Settings → Company & region | `organization` | `ORG_NAME` (company name; country) |
| Settings → Company & region | `region` | `WORK_TIMEZONE`, `CURRENCY`, `DISPLAY_LOCALE` |
| Settings → Storage & backup | `storage`, `ops.backup`, `ops.offsite` | `STORAGE_DRIVER`, `S3_*`, `BACKUP_MODE`, `B2_*` |
| Settings → Notifications | `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Settings → Error reporting | `errorReporting` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_BROWSER`, `SENTRY_LOG_ERRORS` |
| Settings → Agent updates | `agent.updateKey` | `AGENT_UPDATE_PUBLIC_KEY` |
| Settings → Modules | `features` | — (screen only) |
| Settings → Privacy | `privacy` | — (screen only) |
| Settings → Policies & holidays › Public holidays | `holidays.auto` | — (screen only) |

Server side: `server/src/settings/app-settings.service.ts` reads them (cached,
cleared on save); each subject has a `resolve…()` rule next to it.

## Modules that can be switched off

Settings → Modules (`server/src/features/`). A module is a whole part of the
product; all are on by default. Off hides the screens and makes the
endpoints answer 404 (`@RequiresFeature(...)`); nothing is deleted.

| Key | Module | Off also… |
|---|---|---|
| `payroll` | pay sheet and pay terms (the Payroll page becomes "Leave & months") | |
| `deposits` | security deposits, held back from pay — **needs payroll** | payroll holds nothing back |
| `screenshots` | pictures of the screen, gallery, Live Board screen column | agents stop taking pictures (screen sampling for idle detection goes on); uploads in flight are dropped |
| `appTracking` | apps & websites, productivity, Settings › Apps & sites | agents stop recording apps; counted hours do not change |
| `designTargets` | design target pool, review, hand-out jobs — **needs appTracking** (design-app window titles show which jobs were started) | |

A child module is off while its parent is, and keeps its own switch
(`FEATURE_PARENT`, `effectiveFeatures`). `GET /features` answers what is
actually on; the settings view also has the saved switches.

⚠️ Only whole modules go here. A choice inside a module is a setting on that
module's own page: **Settings → Privacy** (`server/src/privacy/`) holds "staff
see their own screenshots" and how many days screenshots are kept (retention
job, nightly). `/auth/me` answers `canSeeScreenshots`, so the menu and the
server never disagree.

## Public holidays

Imported from the country's public calendar (`calendar/public-holidays.ts`:
BrasilAPI for Brazil, Nager.Date for the rest) by the setup wizard or by
hand. `calendar/holiday-sync.service.ts` keeps them up to date every night
(04:15): this year and next, each year imported once (a deleted day stays
deleted), never into the current or a past month. On after the wizard;
otherwise the owner switches it on in Settings → Policies & holidays.

## Work regimes

Two halves, set in two places:

- **The hours target lives on the work policy** (Settings → Policies &
  holidays): `targetBasis` is `month` (N hours over the month's workdays),
  `week` (N hours a week, spread over the days not off), `day` (N hours each
  workday, e.g. a fixed 09:00–18:00 less a break) or `none` (hours are
  counted, nothing is measured against them). The policy's pay rules say
  whether a monthly salary is cut for a shortfall (`deductShortfall`) and
  whether overtime is paid (`overtimeMultiplier`; empty = not paid).
- **The pay lives on the person** (Staff → Directory, owner only):
  `payBasis` is `monthly` (a salary), `hourly` (a rate × the hours counted,
  plus paid leave) or `none` (not paid through oXeio). Changes keep the old
  terms as a `salary_periods` slice, so earlier months pay at earlier terms.

Every target basis is turned into one pair — target seconds over the
month's workdays — by `server/src/calendar/work-regime.ts`
(`targetSpreadOf`), so the rollup, pace, tray and payroll math stay one
formula. A `none` policy sets `noTarget`: screens and the tray show hours
only, and a target of 0 does not read as a day off.

## Time zone

The work day is counted in one IANA zone (setup wizard, then Settings →
Company & region; `WORK_TIMEZONE` before that). Daylight saving is
supported: `server/src/agent/util/zone.ts` asks the tz database for the
offset in force at each instant, so a day can be 23 or 25 hours long and a
skipped midnight is handled. Everything goes through `work-time.ts`
(`workDateOf`, `startOfWorkDate`, `nextLocalMidnight`, …) — never add or
subtract an offset by hand. The agent gets the zone's offset changes for a
year ahead in its config (`zoneTransitions`) and cuts days with them
(`agent/src/oXeio.Core/Time/WorkTime.cs`); the dashboard uses `Intl` with the
zone name (`web/src/lib/format.ts`). Nightly jobs run at 03:00 and 03:30,
never in the 02:00 hour that daylight saving skips or repeats.

## Account page

Every signed-in person has **Account** (`/account`; the old `/security`
redirects there; the name in the sidebar's foot links to it): their profile,
password, 2FA, theme, recent sign-ins and "Sign out other devices". Server:
`server/src/auth/account.*` — no id in any route, it always acts on the
session's user. Staff accounts take their name from the staff record; only
accounts without one rename themselves. The theme is saved on the user
(`users.preferences`) and applied at sign-in. Signing out other devices (and a
new password) sets `users.sessions_revoked_at`; older tokens end at their
next refresh, at most 5 minutes later (`JwtAuthGuard`).

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
| `staff/` | the people, their portal logins and roles, staff codes |
| `calendar/` | holidays (import from a file or from the public calendar — `public-holidays.ts`, date.nager.at, ~200 countries), work policies, agreed leave, closing a month |
| `setup/` | the first-run wizard and the defaults it starts from (`default-categories.ts`, work week by country) |
| `devices/` | the owner's side of the PCs: enrolment codes, revoke/restore, agent builds and rollout stages |
| `me/` | "My data" for the signed-in person |
| `auth/` | login, sessions (JWT cookie + CSRF), 2FA, role guard |
| `alerts/` | alert rules (agent down, tamper, no activity, disk, backup), dispatch to email / Telegram / Teams |
| `digest/` | daily and weekly summaries |
| `ops/` | the server's own backup, offsite copy, health |
| `settings/` | dashboard-editable settings (see above) |
| `features/` | module switches (see above) |
| `error-reporting/` | Sentry |
| `storage/` | where screenshots are stored: local disk or S3/B2 |
| `audit/` | the audit log: the writer every module uses, and the screen that reads it |
| `health/` | `GET /health` |
| `prisma/`, `common/`, `scripts/` | database client, shared helpers and validation patterns, one-off scripts |

Database schema and migrations: `server/prisma/`. Seed: `server/prisma/seed.ts`
(`seed-config.ts` for its settings; with `SEED_COUNTRY` it fetches that
country's public holidays like the setup wizard does). Holiday file import:
`server/prisma/import-holidays.ts`; both plan inserts with `holiday-seed.ts`.

## Dashboard — `oxeio-monitor/web/src`

| Folder | What it holds |
|---|---|
| `api/` | typed calls to the API, one file per module: `staff`, `payroll`, `calendar` (holidays, work policies), `agent` (devices, agent builds), `settings`, `audit`, `reports`, `targets`, `screenshots`, `dashboard`, `activity`, `alerts`, `me`, `features`, `errorReporting`, `auth` |
| `auth/`, `features/` | session and module-switch contexts |
| `components/` | layout, tables, cards; `ui.tsx` has the shared form pieces (fields, modals, confirm dialogs, notices) |
| `lib/` | formatting (time zone, currency, locale), downloads, crash reports |
| `pages/<module>/` | one folder per menu item: `live`, `worklog`, `targets`, `me`, `staff` (Today + Directory tabs), `screenshots`, `monthly`, `reports`, `payroll`, `alerts`, `account` (login, password, 2FA), `settings` (grouped: Work · Company · Integrations · System · Records) |

The menu is built in `components/Layout.tsx` (roles and module switches per
item); routes are in `App.tsx`.

## Agent — `oxeio-monitor/agent`

| Project | What it holds |
|---|---|
| `src/oXeio.Core` | platform-free logic (time, tracking, capture rules) — builds and tests on Linux |
| `src/oXeio.Agent` | the Windows tray app: capture, sync, local outbox, UI. `AgentHost` (the app's core) is one partial class split by concern: `AgentHost.cs` (fields, start, shutdown) and `AgentHost.Tracking/Capture/Sync/Account/Updates/Config/Events/Status/Session.cs` |
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

All code, comments and messages are in English, and nothing is tied to one
country: the time zone, currency, locale, weekly days off and public holidays
come from settings, from the setup wizard's per-country starting points, or
from the public holiday calendar. A holiday whose date is not final yet is
flagged in `holidays.approximate`. Old migrations are kept exactly as they
ran.

## Docs

[docs/README.md](README.md) lists every document: the original project's
design history (mostly not in English) and what each is still useful for. The
deployment manual is `oxeio-monitor/deploy/README.md` (English).
