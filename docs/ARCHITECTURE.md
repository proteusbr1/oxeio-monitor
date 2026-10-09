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

## Production

- Branch **`main`** is production: every push deploys through Coolify
  (`docker-compose.coolify.yml`, `coolify/` — owned by the infra side, do not
  edit or delete), and CI runs on every push to it. Until 2026-10-09 the
  deploy branch was `pericialmed`; it is kept frozen at that day's release.
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
| Settings → Notifications › Email (SMTP) | `smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Settings → Notifications › Who receives each email | `mail.recipients` | `ALERT_EMAIL_TO` (alerts), `DIGEST_EMAIL_TO` (summaries, month closed) |
| Settings → Error reporting | `errorReporting` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_BROWSER`, `SENTRY_LOG_ERRORS` |
| Settings → Agent updates | `agent.updateKey` | `AGENT_UPDATE_PUBLIC_KEY` |
| Settings → Modules | `features` | — (screen only) |
| Settings → Privacy | `privacy` | — (screen only) |
| Settings → Hours statement | `payPeriod` | — (screen only) |
| Settings → Policies & holidays › Public holidays | `holidays.auto` | — (screen only) |

Each card set on screen offers "Use the .env value", which forgets the saved
value (`DELETE /settings/env/:subject`).

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

When pictures are taken is a work-policy setting (Settings → Policies):
whenever the computer is in use (the default — no window), or only between
two times. Either way only while someone is at the keyboard or mouse.
| `appTracking` | apps & websites, productivity, Settings › Apps & sites | agents stop recording apps; counted hours do not change |
| `designTargets` | design target pool, review, hand-out jobs — **needs appTracking** (design-app window titles show which jobs were started) | |
| `hoursStatement` | pay periods and the hours statement for hourly staff, the finance role's screen | |

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

**What counts as worked time** is also the policy's: `hoursMeasure` is `active` (keyboard/mouse time, the original measure) or `presence` (the day's active stretches joined across pauses up to `presenceGapMin`, default 15). The day roll-up stores both (`worked_sec`, `presence_sec`); `credited_sec` is the policy's measure plus adjustments, so everything that reads credited time follows. Changing the measure queues last month and this month for recount (`summary/recount.ts`); closed months stay. So does changing `presenceGapMin` on a presence policy, and moving a person to a policy that counts differently (another measure, or presence with another gap).

**A fixed schedule can be checked**: with `scheduleEnforced`, the office hours, `breakMinutes`, the break window and two tolerances (per clock mark, per day) are checked every workday against the day's presence blocks. Results (`schedule_days`, minutes since local midnight) show on the Schedule screen and in the daily summary (the email names who and what; Telegram carries only the count); days off, holidays, leave and days outside a person's employment are not checked, and a day that stops being checked loses its row; the month balance leaves out the running day; the balance is information, never pay. A required break must be longer than `presenceGapMin` (a shorter pause is merged into presence and never seen), so the policy form shows the gap whenever the schedule is checked. Changing the schedule (its days off, or the presence gap) of a policy that checks one, or switching the check on or off, or moving a person to a policy with a different schedule, queues last month and this month for recount; so do a new first day, a deactivation or a reactivation of a person on a checking policy. Leave added or removed, and a holiday added, imported, moved or removed, queue just those dates. Every such queueing goes through `markDirty` (`summary/recount.ts`), which only queues days up to today.

Screens read finished days from the stored rows and count only today live, so a later policy change never rewrites a past day it has not recounted. The Live Board, My data's day list and the month roll-up count by the measure; the tray's pace and its month credited do too, but the tray's today and 7-day bars stay active time — the agent grows them locally between server updates, and it only sees active input. The attendance report (xlsx and PDF) shows presence beside active time for everyone.

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

## Languages

The dashboard speaks English, Brazilian Portuguese and Spanish
(`web/src/i18n/`, i18next). The English text is the key (`t('Save')`), so
an untranslated string still reads correctly; catalogs live in
`web/src/i18n/locales/<lang>/<area>.json`, one file per area of the app,
merged at build time (`en` holds only plural forms). Which language shows:
the person's own choice (Account page, `users.preferences.language`) › the
company default (Settings → Company & region, setting `region.language` or
`DEFAULT_LANGUAGE`) › the browser › English. Dates use the language's month
and weekday names unless a display locale asks for numeric dates.

Server error messages are written in English and translated on the
dashboard by `web/src/i18n/server-messages.ts` (exact keys plus patterns in
`locales/<lang>/server.json`) — when a server message changes, update its
key there too. Email text written through `mail/mail-text.ts` follows the
company language; the older emails, Telegram, PDF and Excel output are still
English.

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

## Hours statement

Module `hoursStatement` (`server/src/hours-statement/`). It tells whoever does
the pay how many whole minutes (shown as hours and minutes) each hourly person
is owed for a pay period, and carries the leftover seconds into the next one.
**No money appears anywhere** — not on the screen, in the email or in the
spreadsheet; staff are chosen by their pay basis only.

- **Periods** (`pay-period.rules.ts`). A period runs from the day after the
  previous period's end through the next cutoff. The cutoff is a day 1–28 or
  the end of the month (Settings → Hours statement, key `payPeriod`, with the
  send time). The newest row is the *open* period and is the anchor of the
  next one; the first run never backfills. A cutoff change moves only the open
  period's end — except before any period was frozen: then the open period
  becomes the one holding today under the new cutoff (start and end), so the
  first period is never stated with the default cutoff's start. **Set the
  cutoff right after deploy, before the first period ends.** Saving the same
  cutoff (only the send time) leaves the open period alone.
- **The job** (`hours-statement.job.ts`) runs at minute 10 of every hour and
  decides by the clock: a period is due on the day after its end at the send
  time, or on any later day. It freezes the period once (a guarded
  transaction), delivers it, and opens the next. Frozen periods that are
  pending or failed are retried every hour, up to 24 attempts; the alert
  `statement_delivery_failed` is raised when the 24th attempt fails. A freeze
  that throws is logged and tried again next hour without stopping the
  retries; a period still not frozen 3 hours after its send moment raises the
  same alert type ("The hours statement could not be prepared").
- **Delivery guarantee.** At-least-once: a duplicate email is possible after a
  database error. An email stays unsent only when the 24 attempts are used,
  or the outcome is `no_recipients`, `not_configured` or `no_staff` (never
  retried automatically). The owner resends those — or any other frozen
  statement — from the screen; each resend is audited. The mail server's raw
  error is shown to owners only.
- **Who is in** (`statement.rules.ts`): active people, or those who left on or
  after the period start. A person's line covers only the days of the period
  that fall in months they were paid by the hour (a basis change takes effect
  from a month), cut at joining and leaving.
- **Ledger** (`ledger.rules.ts`). Carry-in = the real credited time now over the
  person's earlier frozen lines − posted minutes × 60. To post =
  `floor((measured + carry) / 60)` whole minutes, measured and carry in
  seconds; the leftover seconds carry on. A leaver's leftover carry is never
  settled: there is no next line for it to land on.
- **Frozen periods stay put.** Policy-driven recounts (a measure, schedule or
  gap change, a person moved to another policy) start the day after the
  latest frozen period (`summary/recount.ts › policyRecountDates`), so stated
  hours are not re-credited. Leave and holiday corrections still recount
  their own days; a change there shows up as next period's carry-over.
- **Posted marks.** The finance person marks a line as posted once it is
  entered. A mark can be undone until the next snapshot is taken; after that
  the answer is 409. Both are audited with the note and the previous mark.
- **Recipients.** Active `finance` logins plus extra addresses saved under
  Settings → Notifications (mail kind `hoursStatement`). There is no
  environment fallback and owners are never added by default.
- **Email and sheet.** The email is in the company language, the spreadsheet in
  English. The email links to the screen using `PUBLIC_URL` (or `CORS_ORIGIN`).
- **Screen.** `/hours` (`web/src/pages/hours`); the `finance` role lands there
  and its menu shows Hours statement and Account only.

## Roles

`owner` (everything), `manager` (team, reports, screenshots — no money, no
system settings), `coordinator` (adds and checks tasks; own data otherwise),
`employee` (own data only), `finance` (the hours statement only — refused on
every route that does not name it; shell routes carry `@EveryRole()`). Roles
are checked on the server (`@Roles(...)` and per-service scope rules); the
dashboard only hides what a role cannot use.

## API — `oxeio-monitor/server/src`

| Folder | What it does |
|---|---|
| `agent/` | everything the Windows agent calls: enrolment, config, heartbeat, activity and screenshot ingest, updates and their gradual rollout, capability health |
| `activity/` | app/site usage and the categories they fall into |
| `summary/` | daily and monthly roll-ups (hours, targets, pace), day close, retention of old screenshots |
| `dashboard/` | the Live Board: team status (`dashboard.live.service.ts`), pulse plus one person's timeline and hourly chart (`dashboard.day.service.ts`), 7-day trend and month card (`dashboard.trend.service.ts`); shapes in `dashboard.types.ts`, pure rules in `dashboard.math.ts` |
| `screenshots/` | the gallery and signed image links (who may see whose) |
| `reports/` | attendance / summary / apps reports, Excel and PDF, the monthly report delivery. `reports.service.ts` is the front door; one file per report (`reports.attendance.service.ts`, `reports.summary.service.ts`, `reports.productivity.service.ts`), the shared range / employees / target / meta in `reports.context.service.ts`, download name and export audit in `reports.export.service.ts` |
| `payroll/` | the pay sheet, currency |
| `hours-statement/` | pay periods with a cutoff day, the hours statement of hourly staff (snapshot, carry-over ledger, email, spreadsheet), the hourly job, posted marks. Rules: `pay-period.rules.ts`, `ledger.rules.ts`, `statement.rules.ts` |
| `deposits/` | security deposits ledger and settlements |
| `tasks/` | tasks: the full list, stats and owner edits (`tasks.service.ts`), bulk add to the pool (`tasks.pool.service.ts`), hand-out / top-up / return jobs (`tasks.handout.service.ts`), the assignee's own list and actions (`tasks.person.service.ts`), check / fix / review / deliver / publish (`tasks.stage.service.ts`), file trace (`on-screen.service.ts`); shapes in `tasks.types.ts`, pure rules in `tasks.rules.ts` |
| `schedule/` | schedule compliance: the day check written by the roll-up (`schedule.rules.ts` is the rule), the Schedule screen, the "Schedule today" digest block |
| `adjustments/` | hour corrections made by the owner |
| `staff/` | the people, their portal logins and roles, staff codes |
| `calendar/` | holidays (import from a file or from the public calendar — `public-holidays.ts`, date.nager.at, ~200 countries), work policies, agreed leave, closing a month |
| `setup/` | the first-run wizard and the defaults it starts from (`default-categories.ts`, work week by country) |
| `devices/` | the owner's side of the PCs: enrolment codes, revoke/restore, agent builds and rollout stages |
| `me/` | "My data" for the signed-in person |
| `auth/` | login, sessions (JWT cookie + CSRF), 2FA, role guard |
| `alerts/` | alert rules (agent down, tamper, no activity, disk, backup), dispatch to email (through `mail/`) / Telegram / Teams |
| `mail/` | sending email for every module (SMTP from Settings → Notifications or the .env), recipients per kind of email, email text in the company language |
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
| `api/` | typed calls to the API, one file per module: `staff`, `payroll`, `calendar` (holidays, work policies), `agent` (devices, agent builds), `settings`, `audit`, `reports`, `targets`, `screenshots`, `dashboard`, `activity`, `schedule`, `alerts`, `me`, `features`, `hoursStatement`, `errorReporting`, `auth` |
| `auth/`, `features/` | session and module-switch contexts |
| `components/` | layout, tables, cards; `ui.tsx` has the shared form pieces (fields, modals, confirm dialogs, notices) |
| `lib/` | formatting (time zone, currency, locale), downloads, crash reports |
| `pages/<module>/` | one folder per menu item: `live`, `worklog`, `targets`, `me`, `staff` (Today + Directory tabs), `screenshots`, `monthly`, `schedule`, `reports`, `payroll`, `hours`, `alerts`, `account` (login, password, 2FA), `settings` (grouped: Work · Company · Integrations · System · Records) |

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

Updates: the owner publishes on Settings → Agent updates, or whoever runs the
server publishes from the command line
(`node dist/scripts/publish-agent-version.js`, deploy/README.md › "Publishing
from the server's command line"). Agents from 0.5.1 react to the heartbeat's
`update_agent` within about a minute; staff confirm the install from the tray.

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
