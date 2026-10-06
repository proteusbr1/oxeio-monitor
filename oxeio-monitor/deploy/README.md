# oXeio Monitor — deployment guide

How to run oXeio in production: the server, TLS, backups, updates, and the
Windows agent on every PC. The short version is the
[Quick start](../../README.md#quick-start) in the main README; this guide is
the long version, with the reasons and the traps.

All server commands run in the compose folder, `oxeio-monitor/` inside the
repository (on a VPS set up by the script: `/opt/oxeio/oxeio-monitor`).

**Contents**

1. [How it fits together](#1-how-it-fits-together)
2. [Requirements](#2-requirements)
3. [Install on a VPS with one command](#3-install-on-a-vps-with-one-command)
4. [Install by hand with Docker Compose](#4-install-by-hand-with-docker-compose)
5. [First run: the setup wizard](#5-first-run-the-setup-wizard)
6. [TLS](#6-tls)
7. [Firewall](#7-firewall)
8. [Screenshots in an S3-compatible bucket](#8-screenshots-in-an-s3-compatible-bucket)
9. [Backups](#9-backups)
10. [Updating](#10-updating)
11. [Hardening](#11-hardening)
12. [External uptime monitoring](#12-external-uptime-monitoring)
13. [The Windows agent](#13-the-windows-agent)
14. [First-day checks](#14-first-day-checks)
15. [Troubleshooting](#15-troubleshooting)
16. [The scripts in this folder](#16-the-scripts-in-this-folder)

> **Tell people first.** Monitoring staff is regulated differently in every
> country; many require written notice, consent or a works-council
> agreement. A [policy template](../../docs/monitoring-policy-template.md) is
> included. The software cannot do this part for you.

---

## 1· How it fits together

`docker compose up -d` starts four services from `docker-compose.yml`:

| Service | What it does | Reachable at |
|---|---|---|
| `postgres` | PostgreSQL 16, all data | `127.0.0.1:5432` only |
| `migrate` | Applies database migrations, then exits. The api waits for it | — |
| `api` | NestJS API | `127.0.0.1:3000` only |
| `web` | Caddy: serves the dashboard and proxies `/api/*` to the api | `8080`, or `80`/`443` in domain mode |

The dashboard and the API share one origin, so there are no CORS or cookie
problems. The agents talk to the same address (`https://<your host>/api/v1/…`).

Two optional extras:

- `docker-compose.vps.yml` — **domain mode**: Caddy listens on 80/443 for
  `PUBLIC_HOST` and gets a Let's Encrypt certificate by itself.
- the `seed` service (profile `seed`) — creates the owner from `.env` for
  scripted installs, instead of the setup wizard.

Database and API ports are bound to `127.0.0.1` on purpose. Do not remove that
prefix: without it the API would be reachable on plain HTTP from the whole
internet, bypassing Caddy and its TLS.

---

## 2· Requirements

**Server**

- Linux with Docker Engine and the Compose plugin (`docker compose version`).
  The VPS script installs Docker itself on Debian/Ubuntu.
- Disk: screenshots dominate. They are deleted automatically after 90 days, or
  they can live in a bucket (§ 8). The disk alerts (80 % / 95 %) matter: when
  the disk fills, Postgres stops writing.
- Outbound internet: Let's Encrypt (domain mode), and `date.nager.at` for
  importing public holidays.
- For agents outside the office: a domain name with an `A` record pointing at
  the server. Use a subdomain (`monitor.example.com`); there is no need to move
  nameservers.

**Build machine (Windows, once per agent release)**

- .NET 8 SDK and the WiX command-line tool (`wix`).
- Windows PowerShell 5.1 (stock Windows) is enough; PowerShell 7 is not needed.

**Staff PCs**

- Windows x64. Installing the MSI needs administrator rights once.

---

## 3· Install on a VPS with one command

For a fresh Debian/Ubuntu VPS with a domain. As root:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/proteusbr1/oxeio-monitor.git /opt/oxeio
bash /opt/oxeio/oxeio-monitor/deploy/vps-setup.sh monitor.example.com
```

**Set up DNS first.** Add the `A` record (`monitor` → the VPS's IP) and check
it with `nslookup monitor.example.com 8.8.8.8` (ask a public resolver: your
own may have an old answer cached). The script refuses to continue until the
name resolves to this server: if Caddy asked Let's Encrypt too early, the
failed validations would lock the domain out for an hour.

What `vps-setup.sh` does, in order:

1. installs Docker if missing;
2. installs and enables `ufw`: ports 22, 2222, 80 and 443 open, everything
   else closed (2222 is a spare SSH port, see § 15);
3. clones or updates the code in `/opt/oxeio` (override with `OXEIO_DIR`,
   `OXEIO_REPO`);
4. checks that the domain resolves to this server;
5. creates `.env` with freshly generated secrets — `POSTGRES_PASSWORD`,
   `JWT_SECRET`, `SCREENSHOT_URL_SECRET`, `BACKUP_PASSPHRASE`, `SETUP_TOKEN` —
   plus `PUBLIC_HOST` and `COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml`;
   and creates the storage and backup folders owned by the api's user;
6. runs `docker compose up -d` (the first build takes a few minutes) and waits
   for the API to answer;
7. prints the setup link: `https://monitor.example.com/setup?token=…`.

Open the link and go through the wizard (§ 5). The certificate takes 10–60
seconds to arrive; until then the browser shows an error.

**Safe to run again.** If a step fails, fix the cause and run the same line.
Once `.env` exists it is never touched again (regenerating would change the
secrets). If the wizard was already completed, the script says so instead of
printing a link.

**Copy `BACKUP_PASSPHRASE` off the server now** (password manager). Backups
are encrypted with it; without it they cannot be opened.

Then run [`vps-harden.sh`](#11-hardening).

---

## 4· Install by hand with Docker Compose

```bash
git clone https://github.com/proteusbr1/oxeio-monitor.git
cd oxeio-monitor/oxeio-monitor
cp .env.example .env
```

Edit `.env`. Every variable the server reads is listed there with an
explanation, including the ones you can leave empty. Before the first start:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | a long random string (`openssl rand -base64 32`) |
| `JWT_SECRET` | at least 32 characters (`openssl rand -base64 48`); the server refuses to start otherwise |
| `BACKUP_PASSPHRASE` | a long random string. **Empty = no backups at all** (§ 9). Keep a copy off the server |
| `SMTP_*` | optional, but with `SMTP_HOST` empty, email alerts and digests reach nobody — they are stored and nothing more |

`POSTGRES_PASSWORD` is applied only when the database volume is first
created; changing it later does not change the database's password.

The time zone, currency, date format and company name are set in the setup
wizard, not here (`WORK_TIMEZONE`, `CURRENCY` and `DISPLAY_LOCALE` stay empty).

**Create the data folders** owned by uid 1000 (the api runs as `node`). If
Docker creates them, they belong to root and every screenshot and backup write
fails:

```bash
mkdir -p .data/storage .data/backups
sudo chown 1000:1000 .data/storage .data/backups
```

Then choose one of three ways to expose it.

### 4.1· Domain mode (Caddy is the edge, automatic HTTPS)

Point the domain's `A` record at the server, then add to `.env`:

```bash
PUBLIC_HOST=monitor.example.com
COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml
```

`COMPOSE_FILE` makes a plain `docker compose …` use both files every time.
Without it, a forgotten `-f` would bring Caddy back on `:8080` with 443 closed.
The overlay also sets `PUBLIC_URL` and `CORS_ORIGIN` to `https://$PUBLIC_HOST`.

### 4.2· Plain HTTP on the office LAN (trial)

Leave `PUBLIC_HOST` and `COMPOSE_FILE` unset. The dashboard is served on
`http://<server>:8080` (`WEB_PORT` changes the port). Set
`PUBLIC_URL=http://<server-ip>:8080` so the setup link in the log is complete.

Agents can connect to `http://<server>:8080`, but device tokens and
screenshots then cross the network unencrypted. Fine for a trial; for real use
add TLS (§ 6.3) or use a domain.

### 4.3· Behind another reverse proxy

See § 6.2.

### Start

```bash
docker compose up -d
docker compose ps -a              # postgres, api, web healthy; migrate exited (0)
docker compose logs api | grep setup
```

`up -d` builds the images, runs `migrate`, then starts the api and the web.
There is no separate migration step, on the first install or later.

---

## 5· First run: the setup wizard

While there is no owner account, the api prints a one-time link at every start:

```
First run — no owner yet. Open https://monitor.example.com/setup?token=… to set up oXeio.
```

```bash
docker compose logs api | grep setup
```

Without `PUBLIC_URL` the line starts with `<this server>`: put your own
address in front of `/setup?token=…`. To choose the token yourself instead of
reading the log, set `SETUP_TOKEN` in `.env` (the VPS script does this).

The token exists so that a stranger who finds a fresh install cannot claim
it. Every other page shows the wizard until it is done, and the link stops
working once the owner exists.

The wizard asks for:

1. the company name and country;
2. the time zone, currency and date/number format;
3. the owner account (email and password);
4. the work week.

It creates the owner, a default work policy and app categories, and imports
the country's public holidays for this year and next. If the time zone differs
from the server's, the api restarts itself once. Everything can be changed
later under **Settings** (Company & region, Policies & holidays, Modules, …).

Next: turn on two-factor login for the owner (**Account**), then add your
people (§ 13.1).

### Scripted installs (no wizard)

The `seed` service creates the owner, the first work policy and holidays from
`.env`, after which the wizard no longer appears:

```bash
# in .env: SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, SEED_OWNER_NAME,
#          WORK_TIMEZONE, CURRENCY, SEED_COUNTRY, SEED_POLICY_*
docker compose --profile seed run --rm seed
```

Read the `SEED_*` comments in `.env.example` first. The seed's built-in
defaults are those of the original deployment (Bangladesh holidays, 208 hours
over 26 workdays, Friday off), so set `SEED_COUNTRY` (`none` for no holidays)
and the `SEED_POLICY_*` lines explicitly. The `SEED_*` values are read only
when the database is first seeded.

---

## 6· TLS

### 6.1· Domain mode: Caddy does it

With `PUBLIC_HOST` and the VPS overlay (§ 3, § 4.1), Caddy obtains and renews
the Let's Encrypt certificate itself. Nothing is installed on any PC.

- Ports 80 **and** 443 must be open: 80 is used for Let's Encrypt validation
  (and redirects everything else to 443).
- Certificates live in the `caddy-data` volume. Do not delete it: Let's
  Encrypt allows only a few certificates per domain per week.
- Follow progress with `docker compose logs -f web`.
- The dashboard can be installed as an app on phones (PWA). Browsers allow
  that only over HTTPS.

### 6.2· Behind a reverse proxy

*(Traefik, Nginx, Cloudflare, Coolify, …)*

If another proxy terminates TLS, do **not** use the VPS overlay. Run the base
compose (the `web` service on `WEB_PORT`, default 8080) and point the proxy at
`http://<host>:8080`. In `.env`:

```bash
PUBLIC_URL=https://monitor.example.com         # for the setup link
CADDY_TRUSTED_PROXIES=172.16.0.0/12            # the proxy's address(es), CIDR, space-separated
# CADDY_CLIENT_IP_HEADERS=CF-Connecting-IP     # only with Cloudflare directly in front
```

Why `CADDY_TRUSTED_PROXIES` matters: behind a proxy, Caddy sees the proxy's
address for every visitor. The login rate limit at the edge (30 attempts a
minute per IP) then becomes one bucket for the whole world, and the API's
per-IP lockout (`LOGIN_IP_MAX_FAILS`) and the audit log record the proxy
instead of the person. Caddy believes the client-IP header only from the
addresses listed, so nobody else can pick an IP to dodge the lockout.

- A proxy in a Docker network on the same host (Traefik, Coolify): its range
  is in `docker network inspect <network>`.
- Cloudflare in front: list Cloudflare's ranges
  (<https://www.cloudflare.com/ips/>) and set `CADDY_CLIENT_IP_HEADERS`.
- Leave the API's `TRUST_PROXY` at its default `1`: Caddy hands the API one
  address, already decided.

Check: sign in from two different networks, then open **Settings → Audit log**.
The two rows must show two different addresses, neither of them the proxy's.

### 6.3· LAN install with a self-signed certificate

Without a public domain, Let's Encrypt cannot issue a certificate. The
alternative is a self-signed certificate served by the API itself on port 443.
Agents connect to `https://<server>`; the dashboard stays on Caddy's port 8080.

**1· Make the certificate** (Windows, in the compose folder):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 `
    -Hostname monitor.office.lan -IpAddress 192.168.0.10
```

Without arguments it uses the machine's name and all its LAN IPv4 addresses.
Check the list it prints: an address the agents or browsers use that is not
in the certificate will not connect. Give the server a **static** LAN IP (or a
DHCP reservation): the certificate and every agent carry the address.

It writes to `deploy\certs\` (kept out of git by `deploy/.gitignore`). If
the server itself runs Linux, make the certificate on any Windows PC and copy
`oxeio-cert.pem` and `oxeio-key.pem` to `deploy/certs/` on the server.

| File | Use |
|---|---|
| `oxeio-cert.pem` | certificate → `TLS_CERT` |
| `oxeio-key.pem` | private key → `TLS_KEY` — **secret** |
| `oxeio.pfx` | both, for renewal with `-ReuseKey` — **secret** |
| `oxeio-pin.txt` | the SPKI pin for the agent (§ 6.4) and the expiry date |

**2· Turn on TLS in the API.** Create `docker-compose.override.yml` next to
`docker-compose.yml` (Compose reads it automatically when `COMPOSE_FILE` is
not set):

```yaml
services:
  api:
    environment:
      TLS_CERT: /certs/oxeio-cert.pem
      TLS_KEY: /certs/oxeio-key.pem
    ports:
      - "443:3000"
    volumes:
      - ./deploy/certs:/certs:ro
```

Set **both** `TLS_CERT` and `TLS_KEY` or neither: with only one the server
refuses to start, on purpose (a silent fall-back to HTTP would send device
tokens in plain text for months).

**3· Uncomment the `transport http { tls … }` block in `web/Caddyfile`**, or
Caddy keeps sending plain HTTP to the api and every dashboard request returns
502. Then `docker compose up -d --build`.

Check: `docker compose logs api --tail 20` shows `https://`, and

```powershell
curl.exe https://monitor.office.lan/api/v1/health --cacert deploy\certs\oxeio-cert.pem
```

returns `{"status":"ok","db":"up",…}`.

**4· Trust the certificate on every PC** (agents and browsers), as administrator:

```powershell
Import-Certificate -FilePath oxeio-cert.pem -CertStoreLocation Cert:\LocalMachine\Root
```

Copy only `oxeio-cert.pem`, never the `.pfx` or the key. The agent validates
the certificate with Windows' trust store even when a pin is set (§ 6.4).

**Renewal.** The certificate is valid for 825 days by default (`-Days`). Put
the date from `oxeio-pin.txt` in a calendar, 60 days early. Renew with the same
key, so the pin does not change:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 -ReuseKey
docker compose restart api
```

Then import the new `oxeio-cert.pem` on the PCs again (step 4).

**Changing the key** (only if it leaked). A new key means a new pin, and
pinned agents refuse the new certificate. In this order:

1. `make-cert.ps1 -Force` into a separate `-OutDir` → new key and pin;
2. give the agents **both** pins, old and new (`SERVERPIN` takes a
   comma-separated list; re-run the MSI or edit the registry value, § 6.4);
3. confirm every agent has the new list;
4. only then put the new certificate on the server;
5. after a few days, drop the old pin.

Swapping steps 2 and 4 takes the whole fleet offline.

### 6.4· Certificate pinning on the agent

Optional. With `SERVERPIN` set, the agent accepts the server only if its
public key hash (SPKI SHA-256, base64 — printed by `make-cert.ps1`) matches,
**in addition to** Windows' normal certificate checks. It protects against
anyone who manages to get a certificate trusted on the PC.

- The pin is given at install time (`msiexec … SERVERPIN="<pin>"`) and
  stored in `HKLM\SOFTWARE\oXeio\Agent\ServerPin`. It is never downloaded
  from the server — that would defeat it.
- Several pins can be given, comma-separated (for key changes, § 6.3).
- Without a pin, pinning is off and only Windows' checks apply; the agent
  says so in its log.
- **With Let's Encrypt (domain mode), do not pin.** Caddy generates a new key
  at renewal, so every pinned agent would stop connecting about 90 days later,
  all at once.

---

## 7· Firewall

**VPS.** Open only 80 and 443 (and SSH). `vps-setup.sh` does this with `ufw`:
22, 2222, 80, 443. Never open 5432 or 3000; Compose binds them to
`127.0.0.1`. Use SSH keys, not passwords (§ 11).

With the API on the internet, the owner account should have two-factor login
on. Brute-force protection is on by default: 10 wrong passwords lock an
email+IP pair for 2 minutes (`LOGIN_MAX_FAILS`, `LOGIN_LOCK_MINUTES`), 50 lock
the IP (`LOGIN_IP_MAX_FAILS`), and Caddy allows 30 login attempts a minute per IP.

**Office LAN (Windows server).** Allow the API port only from the office
subnet, and never on the Public profile (a laptop on café Wi-Fi is "Public"):

```powershell
New-NetFirewallRule -DisplayName "oXeio API (HTTPS)" `
    -Direction Inbound -Protocol TCP -LocalPort 443 `
    -RemoteAddress 192.168.0.0/24 -Profile Domain,Private -Action Allow
```

Add the same for the dashboard port (8080) if browsers on other PCs use it.

---

## 8· Screenshots in an S3-compatible bucket

By default screenshots are files under `STORAGE_HOST_PATH` (`.data/storage`).
With `STORAGE_DRIVER=s3` they go to a bucket instead (Backblaze B2, MinIO,
AWS, …), and the server's disk keeps only the database, backups and agent
installers.

```bash
# .env — Backblaze B2 example
STORAGE_DRIVER=s3
S3_BUCKET=oxeio-screenshots          # a private bucket
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_REGION=us-west-004
S3_ACCESS_KEY_ID=…                   # a key limited to this bucket
S3_SECRET_ACCESS_KEY=…
# S3_FORCE_PATH_STYLE=true           # MinIO
# S3_PREFIX=oxeio                    # optional folder in the bucket
```

The same settings are on **Settings → Storage & backup** (the screen wins; it
takes effect after a restart, with a button there).

- The bucket stays **private**. The dashboard uses the server's own
  short-lived signed links; the server streams the object. No public URL,
  CORS rule or bucket policy is needed.
- Retention (90 days) deletes from the bucket too.
- At startup the server writes and deletes a probe object and refuses to
  start if it cannot — a wrong key shows up at once.
- Switching an existing install does **not** move old screenshots. Copy the
  `screenshots/` folder to the bucket first (same paths, under `S3_PREFIX` if
  set), e.g. `rclone copy .data/storage/screenshots b2:oxeio-screenshots/screenshots`.

---

## 9· Backups

### 9.1· The nightly backup

The api dumps the database every night at 03:30 (work time zone), encrypts it
with `BACKUP_PASSPHRASE` (AES-256, `openssl enc` format) and writes it to
`BACKUP_HOST_PATH` (`.data/backups`), keeping `BACKUP_KEEP_DAYS` (30) days.
`BACKUP_COPY_TO` adds a second folder (an external drive, a network share).

- **No passphrase = no backup**, deliberately: an unencrypted dump of hours,
  salaries and screenshots on disk is worse than none. The server logs an
  error at start and raises a daily alert.
- **Keep the passphrase off the server.** Lose it and every backup is lost.
- Only the database is dumped. Screenshot files are not (they expire after 90
  days anyway).
- Already backing the database up with another tool (a managed Postgres,
  Databasus, …)? Set `BACKUP_MODE=external` (or on **Settings → Storage &
  backup**). oXeio's own backup and its alert step aside — that tool must then
  alert you.

**Restore.** Each backup folder contains `README-restore.txt` with the exact
commands. In short (stop the api first, and use your `POSTGRES_USER` and
`POSTGRES_DB` if you changed them):

```bash
sha256sum -c oxeio-YYYY-MM-DD-HHMM.dump.enc.sha256
export BACKUP_PASSPHRASE=…
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -in oxeio-YYYY-MM-DD-HHMM.dump.enc -out oxeio.dump -pass env:BACKUP_PASSPHRASE
docker compose stop api web
docker compose exec -T postgres pg_restore -U oxeio -d oxeio --clean --if-exists < oxeio.dump
docker compose up -d
```

Practise this on a spare machine before you need it. A backup that was never
restored is a guess.

### 9.2· Offsite copy

The nightly dump sits on the same disk as the database. If the server is
lost, so is the backup. `deploy/offsite-backup.sh` uploads the dumps with
`rclone` and reports to Telegram (if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
are set). The files are already encrypted, so the storage provider cannot
read them.

It uses `rclone copy`, not `sync` (a wiped server must not wipe the offsite
copy), prunes remote copies older than `OFFSITE_KEEP_WEEKS` (8), and fails
loudly if the backup folder holds no dump.

**Backblaze B2 (recommended: no browser login needed).**

1. On backblaze.com create a **private** bucket (e.g. `oxeio-backups`) and an
   application key with read and write access to that bucket only.
2. Install rclone: `curl https://rclone.org/install.sh | sudo bash`
3. Give the key to oXeio, one of two ways:
   - on **Settings → Storage & backup** (the script reads it from the
     database; nothing is written to disk), or
   - on the server: `bash /opt/oxeio/oxeio-monitor/deploy/offsite-b2.sh` — it
     asks for the key without echoing it, checks that it works, creates the
     bucket if needed, writes `RCLONE_REMOTE` to `/etc/oxeio-offsite.env`
     and runs a first upload.

**Any other rclone remote** (Google Drive, S3, SFTP, …): configure it with
`rclone config`, then

```bash
RCLONE_REMOTE=gdrive:oxeio-backups bash /opt/oxeio/oxeio-monitor/deploy/offsite-backup.sh
```

**Weekly timer.** Install once:

```bash
cat >/etc/systemd/system/oxeio-offsite.service <<'EOF'
[Unit]
Description=oXeio offsite backup
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/oxeio-offsite.env
WorkingDirectory=/opt/oxeio
ExecStart=/usr/bin/env bash oxeio-monitor/deploy/offsite-backup.sh
EOF

cat >/etc/systemd/system/oxeio-offsite.timer <<'EOF'
[Unit]
Description=oXeio offsite backup, weekly

[Timer]
# server time (usually UTC): after the nightly dump, before working hours
OnCalendar=Sat 04:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload && systemctl enable --now oxeio-offsite.timer
systemctl list-timers oxeio-offsite.timer
```

`Persistent=true` runs a missed week when the server comes back up.
`RCLONE_REMOTE` lives in `/etc/oxeio-offsite.env`, not in the unit file, so
it can change without `daemon-reload`.

**A copy on a Windows PC.** `deploy\pull-backups.ps1` downloads new dumps over
SSH (with the key you already use), verifies each against its `.sha256`,
deletes corrupt copies so they are fetched again, and prunes local copies
older than 8 weeks:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\pull-backups.ps1 `
    -ServerHost monitor.example.com -KeyPath $HOME\.ssh\oxeio
```

Schedule it daily in Task Scheduler. It complements an offsite remote; it
does not replace one if the PC and the server share a building.

---

## 10· Updating

On a VPS set up by the script, one command:

```bash
bash /opt/oxeio/oxeio-monitor/deploy/vps-update.sh
```

It pulls the code, builds the new images, applies any pending migration
(asking the database, not git, what is pending), restarts on the new images,
prunes the Docker build cache (keeping 5 GB), and waits for `/api/v1/health`
to report the commit it just built. If the build or a migration fails, the
running stack is left on the old code.

It refuses to run on a checkout with local changes to tracked files, or one
older than the last deployed commit (recorded in `.git/oxeio-deployed-commit`).

By hand, anywhere:

```bash
git pull
docker compose up -d --build
```

Do not forget `--build`: without it the old images keep running and nothing
seems to change. The `migrate` service runs before the api on every `up`.
The seed never runs during an update.

The dashboard shows a warning when the web and api versions differ (a
half-finished deploy).

---

## 11· Hardening

Once the stack is up, on the VPS as root:

```bash
bash /opt/oxeio/oxeio-monitor/deploy/vps-harden.sh
```

It installs **fail2ban** with an SSH jail and enables **security-only
automatic updates**, then verifies the live state (the actual firewall rules,
the ports sshd listens on, the update timers) instead of trusting the config
files. Safe to run again; it restarts nothing when nothing changed.

- The jail guards ports `22,2222` explicitly. fail2ban's default `port = ssh`
  means only 22, which would leave a second SSH port unguarded while
  `fail2ban-client status sshd` looked fine. If sshd listens elsewhere, the
  script says so; pass the ports with
  `OXEIO_SSH_PORTS=22,2222,2022 bash …/vps-harden.sh`.
- Bans last 1 hour after 5 failures in 10 minutes (`OXEIO_BANTIME` changes the
  length). Never make them permanent: if you ban yourself, the only way back
  is the provider's web console.
- Exempt a **static** office IP with `OXEIO_IGNOREIP="203.0.113.7"`. Never a
  dynamic one: tomorrow it belongs to someone else.
- If you are banned, from the web console: `fail2ban-client set sshd unbanip <IP>`.
- Updates never reboot by themselves. `cat /var/run/reboot-required` tells you
  when a reboot is due; pick a time outside working hours.
- The script does not touch sshd's configuration or ufw rules.
- Ports 80/443 are outside the jail: Docker's published ports bypass the
  `INPUT` chain where fail2ban bans. The login route is rate-limited in Caddy
  instead (`web/Caddyfile`).

**Use an SSH key** before running it, so a mistyped password can never lock
you out:

```powershell
ssh-keygen -t ed25519 -C "oxeio-admin" -f "$env:USERPROFILE\.ssh\oxeio"
```

Append the `.pub` file to `~/.ssh/authorized_keys` on the server (mode 600,
folder mode 700), then `ssh -i $env:USERPROFILE\.ssh\oxeio root@<server>`.
Turn off password login (`PasswordAuthentication no`) only after the key has
worked. Never send a root password in chat or email; if you have, change it
with `passwd`.

---

## 12· External uptime monitoring

A server that is down cannot send its own alert. Use an outside monitor, such
as a free UptimeRobot account:

| Field | Value |
|---|---|
| Monitor type | **Keyword** (not plain HTTP) |
| URL | `https://monitor.example.com/api/v1/health` |
| Keyword | `"db":"up"` (alert when it does **not** exist) |
| Interval | 5 minutes |

`/api/v1/health` returns HTTP 200 even when the database is down (it reports
`"status":"degraded"`, `"db":"down"` in the body), so that Docker's healthcheck
does not restart-loop the container. A status-code monitor would stay green
with the database dead.

Add a second, plain HTTP(S) monitor on `https://monitor.example.com/`: Caddy
and the API can fail independently. Send alerts to the same place as the
app's own (Telegram, email), and test once with `docker compose stop postgres`
for a minute.

---

## 13· The Windows agent

### 13.1· People and portal accounts

Every PC is signed in by the person who uses it, with their own **portal
account**. Create them first: **Staff → Directory** → add the person (work
policy, how they are paid) → **Portal account**. The temporary password is
shown once; hand it over. The same account opens their **My data** page.
Owner and manager accounts cannot sign in an agent — they are not linked to a
staff record.

### 13.2· Building the MSI

On a Windows machine with the .NET 8 SDK and WiX:

```powershell
cd oxeio-monitor\agent\installer
.\build.ps1 -ServerUrl https://monitor.example.com
```

- The server address is **baked into the MSI**, so every PC installs with a
  double-click. Always pass `-ServerUrl`: the script's built-in default is the
  original deployment's address. `-NoServerUrl` builds an MSI that needs
  `msiexec … SERVERURL=…` instead.
- Give only scheme and host — no `/api/v1`, no trailing slash. The script
  checks the shape.
- The version comes from `agent/Directory.Build.props`; do not pass
  `-Version` (the MSI and the agent would report different versions).
- The output is `agent\installer\bin\oXeioAgent-<version>.msi`. Old builds
  stay beside it, so you can always tell which file you are distributing.
- `-HideLatestShot` builds a variant whose Today window does not preview the
  last screenshot (file name ends in `-nopreview`).

### 13.3· Code signing

Unsigned, Windows shows "Unknown publisher" at install. A self-signed
code-signing certificate is enough for your own PCs:

```powershell
# in the compose folder (oxeio-monitor\)
# once — prints the thumbprint; keep deploy\certs\oxeio-code.pfx backed up
powershell -ExecutionPolicy Bypass -File deploy\make-code-cert.ps1

# every build
.\agent\installer\build.ps1 -ServerUrl https://monitor.example.com -SignWith <thumbprint>
```

Then **once on every PC**, as administrator (with `oxeio-code.cer` next to
the script, or `-CerPath`):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\trust-publisher.ps1 -WhatIf   # look first
powershell -ExecutionPolicy Bypass -File deploy\trust-publisher.ps1
```

It installs the certificate in Trusted Root and Trusted Publishers (a
self-signed certificate is its own issuer, so both are needed). If the `.pfx`
is lost, nothing can be signed with the same identity again, and every PC
needs a new `.cer`.

### 13.4· Installing on each PC

Double-click the MSI as administrator (it writes to `Program Files`, `HKLM`
and adds a logon task). At the next logon the person sees **"Sign in to start
tracking"** and enters their portal account's email and password; the device
is registered in their name. If they close the window, the agent runs but
sends nothing, and asks again at the next logon.

The tray icon is always visible. Staff can open **Today's hours** from it to
see their own time.

### 13.5· Scripted rollout and enrollment codes

For installing without anyone at the keyboard:

```powershell
msiexec /i oXeioAgent-<version>.msi /qn `
    SERVERURL="https://monitor.example.com" `
    ENROLLCODE="<code>" `
    PORTALURL="https://monitor.example.com/me"
```

Other properties: `POLICYURL` (a link to your monitoring policy, shown to
staff), `SERVERPIN` (§ 6.4), `UPDATEKEY` (§ 13.7). `SERVERURL=` on the
command line overrides the address baked into the MSI.

An enrollment code ties one PC to one person. The dashboard has no button for
it yet; an owner creates it through the API
(`POST /api/v1/devices/enrollment-code`, body `{"employeeId": <id>}`; the id
is the number in the person's page address, `/staff/<id>`). For example, from
the browser console while signed in as owner on the dashboard (the request
must carry the `oxeio_csrf` cookie back in `X-CSRF-Token`, as the dashboard does):

```js
const csrf = decodeURIComponent(document.cookie.match(/oxeio_csrf=([^;]+)/)[1]);
fetch('/api/v1/devices/enrollment-code', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  body: JSON.stringify({ employeeId: 7 }) }).then(r => r.json()).then(console.log)
```

Codes are single-use, expire after **24 hours**, and a new code for the same
person cancels the previous one. Create each PC's code on the day you install it.

### 13.6· Antivirus exclusion

On every PC, after installing the agent, as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1 -WhatIf   # look first
powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1
```

It excludes the processes `oXeio.Agent.exe` and `oXeio.Watchdog.exe` and the
folder `C:\Program Files\oXeio`. `%ProgramData%\oXeio` is deliberately left
out: ordinary users can write there, so excluding it would give anyone a
place Defender never scans (`-IncludeDataFolder` only if you really see
slowness). `-Force` skips the prompts in a rollout script (`-Confirm:$false`
does not work with `-File`); `-Remove` undoes it. If another antivirus is
active, the script says so; add the same exclusions in that product's console.

### 13.7· Agent updates

1. Build the new MSI (same `-ServerUrl`, signed).
2. Copy it into the server's storage folder, e.g.
   `.data/storage/updates/oXeioAgent-<version>.msi`.
3. **Settings → Agent updates → Publish**: the version and the path relative
   to the storage folder (`updates/oXeioAgent-<version>.msi`). The server
   computes the checksum from the file.
4. Start with the stage **A few PCs first**, then move to **About half** and
   **Everyone**; **Stopped** halts a bad release.

The agents download the update, check its SHA-256, and install it.

#### Signed agent updates

The checksum catches a broken download, not a compromised server: whoever
controls the server could publish another MSI with a matching hash, and an
update runs as administrator on every PC. With an update key, PCs install only
MSIs signed by a private key that **never sits on the server**.

```bash
# once, on your own machine — keep update-key.pem offline
openssl ecparam -name prime256v1 -genkey -noout -out update-key.pem
openssl ec -in update-key.pem -pubout -out update-key.pub.pem
```

```powershell
# build MSIs with the public key baked in (every later build too)
.\agent\installer\build.ps1 -ServerUrl https://monitor.example.com -UpdatePublicKey update-key.pub.pem
```

```bash
# every release: sign the exact MSI, put the .sig next to it in updates/
openssl dgst -sha256 -sign update-key.pem \
  -out oXeioAgent-<version>.msi.sig oXeioAgent-<version>.msi
```

Also give the server the public key — the one-line base64 body of
`update-key.pub.pem` — in **Settings → Agent updates** (Update signing key) or
`AGENT_UPDATE_PUBLIC_KEY`. The server then refuses to publish an MSI whose
`.sig` is missing or wrong, instead of letting every PC download and discard
it. PCs installed without a key keep checking the hash only; a refused update
appears in the agent log as `Update … refused`.

---

## 14· First-day checks

**Right after installing the agents**

- [ ] The oXeio tray icon is visible on every PC.
- [ ] Every PC appears on the **Live Board**, under the right person.
- [ ] Staff can open **Today's hours** from the tray.

**A few hours later**

- [ ] Hours are increasing.
- [ ] Screenshots arrive, and only inside the capture window of the work policy.
- [ ] App usage shows domains, not full URLs.
- [ ] `docker compose logs api --tail 100` shows no error repeating.

**Next day / end of the week**

- [ ] `%ProgramData%\oXeio` on a PC is not growing (the outbox drains).
- [ ] A dump appeared in `.data/backups` and, if configured, offsite.
- [ ] Targets and pace look plausible for the work policy and the holidays.

---

## 15· Troubleshooting

**Logs**

```bash
docker compose logs api --tail 100
docker compose logs web --tail 100        # certificates, proxy errors
docker compose ps                         # health of each service
```

On a PC: `%ProgramData%\oXeio\logs\agent.log` (today), `agent-YYYY-MM-DD.log`
(earlier days), `outbox-drops.log` (what was dropped from the queue).

**Where is the setup link?** `docker compose logs api | grep setup`. It is
printed at every api start until the owner exists; with `SETUP_TOKEN` set,
it is `<your address>/setup?token=<SETUP_TOKEN>`.

**The stack does not start.** `docker compose logs migrate api --tail 60`.
The api refuses to start, with a clear message, on: `JWT_SECRET` shorter than
32 characters; only one of `TLS_CERT`/`TLS_KEY`; an unreachable S3 bucket with
`STORAGE_DRIVER=s3`; an invalid `BACKUP_MODE`.

### The owner lost the password or the 2FA phone

There is no "forgot password" email. From a shell on the server:

```bash
docker compose exec api node dist/scripts/recover-owner.js --list
docker compose exec api node dist/scripts/recover-owner.js --confirm
```

- Nothing changes without `--confirm`.
- With several owners, choose one with `--email owner@example.com`.
- A new password is generated and shown once; 2FA is removed; a new password
  is required at the next sign-in. The action is written to the audit log.
- If no owner exists at all (e.g. after deleting it by mistake):
  `--confirm --email owner@example.com --name "Name"` creates one.

### Screenshot rows exist, but the images are broken

Almost always the storage folder belongs to root while the api runs as uid
1000. The row is written but the file is not. Check and fix:

```bash
docker compose exec -T api sh -c 'id; ls -ld /data/storage; touch /data/storage/.probe && echo OK || echo DENIED'
chown -R 1000:1000 .data/storage .data/backups && docker compose restart api
```

Images that failed to write are not recovered; new captures will be fine.
With `STORAGE_DRIVER=s3`, check the bucket status on **Settings → Storage &
backup**. If no screenshots arrive at all, check the work policy's capture
window and whether screenshots are enabled for that policy.

### A staff member cannot sign in

- No portal account yet: in **Staff → Directory** the button reads
  **Portal account** (it reads **Login** once one exists).
- Wrong password several times: the lockout lifts after `LOGIN_LOCK_MINUTES`
  (2 by default). Otherwise reset the password from the person's **Login**
  dialog in Staff → Directory; the new one is shown once.
- Deactivated people cannot sign in; **Reactivate** them in Staff → Directory.
- The agent's sign-in window rejects owner and manager accounts on purpose.

### An agent does not connect

- The address in the MSI (`HKLM\SOFTWARE\oXeio\Agent\ServerUrl`) is wrong or
  unreachable — try `https://<host>/api/v1/health` in a browser on that PC.
- Self-signed TLS: the certificate is not in the PC's Trusted Root, has
  expired, or does not list the name/IP the agent uses (re-make it with
  `-Hostname`/`-IpAddress`).
- A pin is set and does not match (was the key changed without the two-pin
  order in § 6.3?).
- A PC shown offline while it is on: check its clock, and whether its outbox
  is still draining.

### SSH times out

`ssh: connect to host … port 22: Connection timed out` does not mean the
server is down. From Windows:

```powershell
foreach ($p in 22,80,443) { $r = Test-NetConnection <server-ip> -Port $p -WarningAction SilentlyContinue; "{0,-4} {1}" -f $p, $r.TcpTestSucceeded }
Test-NetConnection github.com -Port 22
```

If 80/443 answer but 22 does not, the server is fine. If `github.com:22` also
fails, **your network or ISP blocks outbound port 22** (some do, often
together with 25). Get in another way — a VPN, a phone hotspot, or the hosting
provider's web console — and move SSH to a second port as well. `vps-setup.sh`
already opened 2222 in `ufw`.

On Ubuntu 22.10 and later, check `systemctl is-enabled ssh.socket` first. If
it is `enabled`, the listening port is set by `ssh.socket`, not by
`sshd_config`, and adding a `Port` line silently does nothing. Then:

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
printf 'Port 22\nPort 2222\n' >> /etc/ssh/sshd_config   # keep 22 as well
sshd -t                                   # silence = config OK
systemctl disable --now ssh.socket
systemctl enable --now ssh
systemctl restart ssh
ss -tln                                   # expect :22 and :2222 on 0.0.0.0
```

Then `ssh -p 2222 root@<server-ip>`. While you are there, make sure `5432`
and `3000` appear only on `127.0.0.1` in `ss -tln`. Run `vps-harden.sh` again
afterwards so fail2ban covers the new port.

In a browser-based (noVNC) console, symbols like `>` and `|` may arrive
mistyped when text is pasted or sent by automation; `echo … >> file` can then
silently do nothing. Check the result, or use `sed -i '1iPort 2222' /etc/ssh/sshd_config`.

---

## 16· The scripts in this folder

| Script | Runs on | Purpose |
|---|---|---|
| `vps-setup.sh` | VPS, root | First install: Docker, firewall, code, `.env`, stack, setup link (§ 3) |
| `vps-update.sh` | VPS, root | Pull, build, migrate, restart, health check (§ 10) |
| `vps-harden.sh` | VPS, root | fail2ban SSH jail and security-only automatic updates (§ 11) |
| `offsite-backup.sh` | server | Upload the encrypted dumps with rclone (§ 9.2) |
| `offsite-b2.sh` | server, root | Configure a Backblaze B2 remote and run a first upload (§ 9.2) |
| `pull-backups.ps1` | Windows | Copy and verify the dumps over SSH (§ 9.2) |
| `make-cert.ps1` | Windows | Self-signed TLS certificate and SPKI pin for a LAN install (§ 6.3) |
| `make-code-cert.ps1` | Windows (build machine) | Self-signed code-signing certificate (§ 13.3) |
| `trust-publisher.ps1` | every PC, admin | Trust the code-signing certificate (§ 13.3) |
| `defender-exclusions.ps1` | every PC, admin | Microsoft Defender exclusions for the agent (§ 13.6) |

The PowerShell scripts print what they are about to do before doing it;
`trust-publisher.ps1`, `defender-exclusions.ps1` and `make-code-cert.ps1`
accept `-WhatIf`. `make-cert.ps1` only writes files and installs nothing.

- The `.ps1` files are saved **with a UTF-8 BOM**. Keep it: Windows
  PowerShell 5.1 reads a file without a BOM as ANSI, and the non-ASCII
  characters in the messages then break parsing.
- The `.pem` files they write are **without** a BOM: Node cannot read a PEM
  that starts with one.
- `deploy/certs/` holds private keys and is excluded from git. Never commit
  or email `oxeio-key.pem`, `oxeio.pfx` or `oxeio-code.pfx`.
