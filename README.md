# oXeio Workforce Monitor

Self-hosted time tracking and screen monitoring for teams that work on Windows
PCs. Everything runs on one server you control: no SaaS, no per-seat fee, and
no third party holding your staff's screenshots.

It works in any country and with the way your people are actually paid: a
monthly salary against a monthly target, 40 hours a week, a fixed daily
schedule, by the hour, or no target at all.

![The oXeio Live Board — team status, the shape of the day, pace against target, and what needs attention](docs/media/live-board.png)

<sub>The Live Board on demo data. A day the server wasn't watching is the dashed
bar in *Last 7 days*, not a zero.</sub>

---

## What you get

| | |
|---|---|
| **Windows agent** | Active and idle time, the apps and sites in use, and screenshots within the hours you set. Shows a tray icon and a "Today" window, so nothing is hidden. Queues to disk when the network drops, so no hours are lost. |
| **Live Board and Worklog** | Who is working right now, today's hours against each person's target, the week, and the month. |
| **Work regimes** | Each work policy sets the hours target: per month, per week, per day, or none. Each person is paid a monthly salary, by the hour, or outside oXeio. Overtime is paid at a multiplier you choose, or not at all. |
| **Holidays for ~120 countries** | Import your country's public holidays in one click, then add your own company days. Holidays and approved leave reduce the target. |
| **Payroll** | A monthly pay sheet built from the hours actually counted: deductions for missed hours, hourly pay, overtime pay, and security deposits. |
| **Reports and alerts** | Monthly reports (PDF or spreadsheet), a daily email digest, a weekly Telegram summary, and alerts when an agent goes silent. |
| **Self-service** | Everyone has their own **My data** page, showing exactly what was recorded and any correction with its reason, and an **Account** page for password, 2FA, theme and devices. |
| **Roles** | Owner, manager (no access to money), researcher, and staff (own data only). Optional two-factor login. Every sensitive view is written to an audit log. |
| **Modules you can switch off** | Payroll, security deposits, design targets, and whether staff see their own screenshots. |
| **Operations** | A setup wizard on first run, nightly encrypted backups (optionally copied offsite), Sentry error reporting, and signed auto-updates for the agent. |

Most settings are made on screen (Settings), not in config files.

---

## What it refuses to do

Monitoring software earns trust by what it leaves out. These were considered
and **rejected**, not postponed.

| Never | Why |
|---|---|
| **Keystroke logging** | Passwords and private messages would pass through it. There is no safe way to store that. |
| **Reading screen content** | Screenshots are stored and shown. They are never OCR'd, classified or searched. |
| **Webcam or microphone** | Not implemented, not wanted. |
| **Silent installation** | The agent always shows a tray icon. Staff sign the agent in themselves with their own account. |
| **Hiding hours from the person who worked them** | Everyone can see what was recorded about them, including any manual correction and its reason. |
| **Screenshots at any hour** | Capture only happens within the hours set in the work policy, and images are deleted automatically after the retention period. |

One principle runs through the code: **a number must never claim to know
something it doesn't.** A day the server wasn't watching is drawn as an
outline, not a zero. "Agent offline" and "not working" have different colours.

---

## How it fits together

```
Windows PCs                      your server
┌──────────────────┐            ┌──────────────────────────────┐
│ oXeio Agent      │   HTTPS    │  web ──┬── React dashboard   │
│  · active/idle   │ ─────────► │        └── NestJS API        │
│  · screenshots   │            │              │               │
│  · apps & sites  │            │          Postgres 16         │
│ Watchdog         │            │          nightly backup      │
└──────────────────┘            └──────────────────────────────┘
```

- **Agent:** C# / .NET 8 (`oXeio.Agent`, `oXeio.Core`, `oXeio.Watchdog`), installed with an MSI.
- **Server:** NestJS 11, Prisma 6, Postgres 16.
- **Dashboard:** React 19, Vite, Tailwind 4. It can be installed as a PWA.
- **Deployment:** Docker Compose, with Caddy for automatic HTTPS.

---

## Quick start

You need a Linux server with Docker, and a domain name pointing at it if the
agents will connect over the internet.

On a fresh VPS with the domain already pointing at it, one command does steps
1–2 for you: it installs Docker, sets up the firewall, generates the secrets,
starts everything and prints the setup link.

```bash
git clone https://github.com/proteusbr1/oxeio-monitor.git /opt/oxeio
bash /opt/oxeio/oxeio-monitor/deploy/vps-setup.sh monitor.example.com
```

Or by hand:

**1. Get the code and create the configuration**

```bash
git clone https://github.com/proteusbr1/oxeio-monitor.git
cd oxeio-monitor/oxeio-monitor
cp .env.example .env
```

Edit `.env`. Two values must be set before the first start:

| Variable | Set it to |
|---|---|
| `POSTGRES_PASSWORD` | a long random string |
| `JWT_SECRET` | `openssl rand -base64 48` |

That serves the dashboard on plain HTTP, port 8080, which is fine on an office
network. For a domain with HTTPS (Caddy fetches the certificate itself), also
add these three lines:

```bash
PUBLIC_HOST=monitor.example.com
PUBLIC_URL=https://monitor.example.com
COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml
```

Everything else in `.env.example` is optional and explained in place. Email,
Telegram, storage, backups and error reporting can also be set later on the
Settings screen.

**2. Start it**

```bash
docker compose up -d
docker compose logs api | grep setup
```

The second command prints a one-time setup link, `…/setup?token=…`. (Set
`SETUP_TOKEN` in `.env` beforehand if you'd rather choose the token yourself.)

**3. Run the setup wizard**

Open the link. In a few steps you set:

- the company name and country;
- the time zone, currency and date format;
- the owner account;
- the work week.

The wizard imports your country's public holidays and creates a default work
policy. You can change all of it later.

**4. Add your people**

Go to **Staff → Directory**. Add each person, choose their work policy and how
they are paid, and click **Portal account** to give them a login. They use it
both for the dashboard (their own hours) and to sign in the agent.

**5. Install the agent on each PC**

Build the MSI on a Windows machine with the .NET 8 SDK and WiX:

```powershell
cd oxeio-monitor\agent\installer
.\build.ps1 -ServerUrl https://monitor.example.com
```

Install it on each PC as an administrator. At the next logon, the person signs
in with their own portal account, and their hours start showing up on the Live
Board.

To roll out updates later, publish new versions under **Settings → Agent
updates**.

The full deployment guide covers TLS behind another proxy, firewalls,
S3-compatible screenshot storage, offsite backups, signed agent updates and
troubleshooting: [`oxeio-monitor/deploy/README.md`](oxeio-monitor/deploy/README.md).

---

## Development

```bash
# server — tests need a Postgres (see server/vitest.config.ts)
cd oxeio-monitor/server && npm ci && npm test
# dashboard
cd oxeio-monitor/web && npm ci && npm test && npm run dev
# agent — Core tests run anywhere; the full agent needs Windows
cd oxeio-monitor/agent && dotnet test tests/oXeio.Core.Tests
```

Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). It covers where
every module lives, how settings and module switches work, roles, and how the
three programs are deployed and tested.

The other documents in [`docs/`](docs/) are the design history of the
original project, which was built for one company in Bangladesh. They are
mostly in Bengali; [`docs/README.md`](docs/README.md) says what each one is
still useful for.

---

## Legal and ethical use

Employee monitoring is regulated differently in every jurisdiction. In many
places it requires disclosure, consent, or a works-council agreement. A
[monitoring policy template](docs/monitoring-policy-template.md) is included
as a starting point. Adapt it to your language and your law.

**Tell people.** Deploying this without the knowledge of those being monitored
is wrong and, in many countries, illegal. The software cannot enforce consent
for you, and it doesn't try: the "policy signed" date on each person is a
record, not a gate.

---

## Licence

[MIT](LICENSE). Use it, change it, ship it.

The licence releases the copyright, not your obligations to the people you
monitor. Consent, disclosure and data-protection law follow the deployment,
not the code.
