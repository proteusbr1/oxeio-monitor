> **26 September 2026 — release consistency:** keep the VPS checkout and runtime
> on the same commit. `vps-update.sh` now rejects a checkout behind the verified
> deployment marker `.git/oxeio-deployed-commit`, rejects tracked uncommitted changes,
> and verifies the API commit before recording success. Source can be transferred
> by a verified Git bundle when a remote push is unavailable; never reset an ahead
> VPS checkout to an older remote branch. See [audit fixes](../../docs/audits/2026-09-26-fix-tracker.md).

# oXeio — Rollout guide

Step-by-step instructions for installing oXeio on the office's 15 Windows PCs.
The scripts in this folder run on the owner's machine — **none of them installs
anything by itself**; each one first shows what it is about to do.

---

## 0· Before you start — consent

> **In oXeio, consent is taken at joining time** *(the owner's decision)* —
> everyone joins on the office's terms, monitoring included. So there is no
> separate signing step before the rollout, and that is the rule here.
>
> Careful: the `policy_signed_at` field **blocks nothing** — enrollment and
> tracking never stop on it, and never have. The field is a place to record a
> paper date; since this setup has no separate paper, it stays empty, and that
> is not an incompleteness.

Careful: **if someone else installs this system** — the template is in the repo
([`docs/monitoring-policy-template.md`](../../docs/monitoring-policy-template.md))
and it will be useful to you. In many countries informing employees in writing,
or obtaining their consent, is **a legal requirement**; check the rules for
your own area yourself. Software cannot do this for you.

The principle that does not change either way:

- The core of oXeio's design is **no covert surveillance** — the tray icon is
  always visible, and staff can see their own figures themselves (`/me`). Who is
  looking at what is not hidden, whenever consent is taken.

Checklist:

- [ ] The blank fields of the template (`__________`) are filled in
- [ ] A lawyer has reviewed it
- [ ] The signed copies of all 15 people are on file
- [ ] Everyone knows where to see their own data (the staff portal)

---

## 1· What you need

**Two stages** ([ADR-026](../../docs/05-Options-Decisions.md)): first 2–3 days
on the office PC, then on the VPS. The list below is for the office PC; the VPS
sizing and the conditions for choosing a plan are in ADR-026.

| Item | Why |
|---|---|
| A server PC, always on | The API + database run here |
| **A static LAN IP** | If it changes, the 15 agents cannot find the server |
| Docker Desktop | Everything comes up from `docker-compose.yml` |
| Windows PowerShell 5.1 | Ships with Windows; these scripts run on it |
| Admin rights | Firewall, AV exclusion, MSI install |

> Careful: you **must** make the server's IP static (a DHCP reservation on the
> router, or a static IP on the machine). The certificate carries the IP, and
> the agent's config carries the address too — if DHCP changes the IP,
> everything breaks, and the breakage is **silent**: the agents quietly keep
> queuing and nobody notices.

---

## 2a· On the VPS — **one command**

```bash
cd /opt/oxeio && git pull && bash oxeio-monitor/deploy/vps-setup.sh hub.oxeio.com
```

Docker · firewall (22·80·443) · generating secrets · DNS check · migration and
seed · the stack — everything. At the end it prints the owner login **once**.

**Safe to run repeatedly.** If something goes wrong, fix it and run the same
line again; once `.env` has been created it is never touched again.

### First time — two things beforehand

**1· DNS** — where the domain's DNS lives, add one `A` record
(`hub` → the VPS's IP). Careful: there is no need to change the nameservers. Use
a subdomain, not the apex — touching the apex could break the company's main site.

To check that it has propagated: `nslookup hub.oxeio.com 8.8.8.8`
Careful: do not drop the `8.8.8.8` part — your ISP's resolver may have an old or
"no such name" answer cached.

**2· The repo is private, so a deploy key** — it cannot be cloned anonymously:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "oxeio-vps" <<< y
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
cat ~/.ssh/id_ed25519.pub
```

Add that line at GitHub → the repo → Settings → **Deploy keys** → Add.
Careful: **do not tick "Allow write access"** — read access is enough.

Then:
```bash
git clone git@github.com:ownCoder/oxeio-monitor.git /opt/oxeio
```

Careful: **do not make the repo public** — the git history contains a `.env`
backup (with old passwords and tokens, [09 § ৩শ](../../docs/09-Build-Log.md)).

Careful: do not drop the `oxeio-monitor/` part of the path — the script is not
at the repo root, it is one level inside.

---

## 2· Bringing the server up *(by hand, step by step)*

```powershell
cd "C:\...\oXeio Office\oxeio-monitor"

# Create the .env
Copy-Item .env.example .env
notepad .env
```

These must be changed in `.env`:

| Variable | What to set |
|---|---|
| `POSTGRES_PASSWORD` | A long random string |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SEED_OWNER_PASSWORD` | Change it after the first login |
| `SMTP_*` · `ALERT_EMAIL_TO` | Careful: if left empty, **alerts reach nobody** — they are created and stored in the database, and that is all |
| `BACKUP_PASSPHRASE` | Careful: if left empty, **no backup is taken at all** (deliberate — not keeping a dump is safer than keeping one unencrypted) |
| `CORS_ORIGIN` | Only for a client on another origin. Not needed if you use the `web` service below |

> Careful: `.env.example` has **every** variable, including the ones that can be
> left empty. When email or backup is off, nothing shows an error — it is just
> silently off. So glance over the ones you will not use as well.

### 2.1· Schema and first data — **this step cannot be skipped**

```powershell
docker compose --profile setup run --rm migrate
```

**This must be run, before or after `up -d` — but it must be run.** This step
used to be missing from the runbook, so following it step by step left the
database with **not a single table**, and the API came up and failed on every request.

The container cannot do this itself, deliberately: the production image has no
prisma CLI or `tsx` (to keep it small). So it is a separate one-shot service
that does not run on `up -d` — a migration is a conscious step, not something
to run by itself on every restart.

**Safe to run repeatedly** — `migrate deploy` applies only what is pending, and
the seed is entirely upserts.

> **One exception, and it concerns money:** the seed **also loads the holiday
> calendar**, and a new holiday reduces that month's working days, changing the
> target and the payroll fractions. So the seed does not apply anything to the
> current or past months by itself —
> **when to run it, what will move, and what to do afterwards: § 2.1c.**

> Careful: the staff's real names and salaries are in
> `server/prisma/staff.local.json` ([09 § ৩ঊ](../../docs/09-Build-Log.md)). The
> file is **not baked into the image** — it is mounted at run time, so no image
> layer ever contains anyone's salary.

#### Sending the real staff list to the server

The file is not in the repo, so `git pull` does not carry it — **it has to be
sent separately**. But `prisma/` is mounted from the host, so no image rebuild is needed:

```powershell
scp "C:\...\oxeio-monitor\server\prisma\staff.local.json" `
    root@SERVER:/opt/oxeio/oxeio-monitor/server/prisma/
```

Then run the seed again on the server — it is entirely upserts, so it is safe:

```bash
cd /opt/oxeio/oxeio-monitor && docker compose --profile setup run --rm migrate
```

**Row format** — four fields are required, the fifth is optional:

```json
[
  ["OX-01", "Name", "Title", 25000, "2026-01-05"],
  ["OX-02", "Name", "Title", 18000]
]
```

Careful: **do not leave out the fifth field — the joining date.** Without it
the proration **silently treats everyone as a full month**: someone who joined
mid-month gets the full month's target, and sees an unfair deduction at month
end — with no error at all ([09 § ৩ষ](../../docs/09-Build-Log.md)).

If the date is **not given, the field is not touched at all**, so if someone
set it by hand in the dashboard, it survives re-running the seed.

Careful: if the file has a mistake the seed **stops**, it does not silently
skip the row — the message carries both the row number and the staff code.

**Check on your own machine before sending** — it needs no database and writes nothing:

```powershell
cd oxeio-monitor\server
npm run check:staff
```

It shows the 12 people's names, salaries and dates in a table, and also counts
whose date is missing. Otherwise a single comma mistake would only be caught
after going through `scp` → container → docker log.

### 2.1a· Updating later (when new code arrives)

After the first time, this one command every time — nothing else to remember:

```bash
bash /opt/oxeio/oxeio-monitor/deploy/vps-update.sh
```

git pull → migration if needed → rebuild → is the API responding.
**Safe to run repeatedly** — with nothing new it does almost nothing.

**Do not run `--profile setup run --rm migrate` during an update.** That
service's command is `migrate deploy && tsx prisma/seed.ts` — so the seed runs
too, and the seed **upserts the staff's names, salaries and joining dates**.
Data entered by hand in the dashboard would then be **silently** overwritten
with the file's old values — straight into the payroll figures. So
`vps-update.sh` overrides the command and calls only `migrate deploy`.

Do not leave out `--build`. With only `up -d` the old image keeps running — the
code has arrived, yet nothing has changed, and the cause is hard to see. The
script handles this itself.

### 2.1b· Hardening the VPS — fail2ban and security updates

**When:** once, after the stack is up. After that there is nothing to remember —
though it can be run again at any time.

```bash
bash /opt/oxeio/oxeio-monitor/deploy/vps-harden.sh
```

**What it does:** installs fail2ban and enables the SSH jail · enables
security-only automatic updates · and at the end **reads the live state** to
verify (not the config files — the real iptables rules, which ports sshd is
really listening on, whether the timers are really running).
**Safe to run repeatedly** — it does not even restart the service if nothing changed.

**The jail covers ports `22,2222` — both, written explicitly.** fail2ban's
default `sshd` jail says `port = ssh`, and `ssh` means **only 22** according to
`/etc/services`. On this server sshd also listens on 2222 (§ 12.4c), so left at
the default the hardening would be **silently half done**: brute force stopped on
22, any number of tries allowed on 2222 — yet `fail2ban-client status sshd`
would happily show "active". So at the end the script reads
`iptables -S INPUT | grep f2b-sshd` and shows whether **both ports are really guarded**.

**Docker's published ports are outside this jail.** Packets for 80/443 are
DNAT-ed to the Caddy container, i.e. they go through the `FORWARD`/`DOCKER`
chain, not `INPUT` — and fail2ban (and ufw) place bans in `INPUT`. So this will
not stop brute force at the **web layer**, and the failure is silent: the jail
shows "active" and the ban count even grows. The login route's rate limit
therefore has to be set up **in Caddy** — that is the other half of this
hardening work, still to do.

Automatic updates are **security only**, and **never reboot by themselves**. If
a reboot is needed after a kernel update, `cat /var/run/reboot-required` will
say so — the owner picks the time. A sudden reboot in office hours means the
agents' uploads stall, and nobody would understand why screenshots are not arriving.

#### Not locking yourself out

- The script **does not touch sshd** — it does not change the port, does not
  disable password login, does not delete ufw rules. Deliberate: locking your
  own door in the name of "hardening" has nearly happened here once (§ 12.4).
- Bans are **not permanent** — `bantime = 1h`, `maxretry = 5`. Never set
  `bantime = -1` (forever); once your own IP is locked out the only way back is
  the web console, and you have to hunt for it at exactly the moment you have no time.
- **Before** running it, set up an SSH key (§ 12.5) — logging in with a key
  removes any chance of banning yourself by typing a wrong password.
- If you do get banned — log in through the web console:
  ```bash
  fail2ban-client status sshd            # who is banned
  fail2ban-client set sshd unbanip 1.2.3.4
  ```
- If the office has a **static** IP, exempt it beforehand:
  ```bash
  OXEIO_IGNOREIP="103.x.x.x" bash /opt/oxeio/oxeio-monitor/deploy/vps-harden.sh
  ```
  Do not do this with a dynamic IP — tomorrow that IP belongs to someone else,
  and the exemption would go to them.
- If sshd's port ever changes, the jail must change too:
  `OXEIO_SSH_PORTS=22,2222,2022 bash …/vps-harden.sh`
  Even if you forget, the script catches it — it reads which ports sshd is
  listening on, compares with the jail, and says so when they do not match.

What **could not** be verified, the script does not wave through as "fine" — it
says "could not verify" and gives the command to check by hand. Not being able
to find out is not the same as a failure.

### 2.1c· Holiday calendar — running the seed **can move money**

`npm run seed` (or `--profile setup run --rm migrate`) also loads the holiday
list (`server/prisma/holidays.data.ts` — 2026–27). The list is needed: without
it Eid, Ashura and Puja days are counted as **working days**, and everyone's
target and pace look too high. But adding holidays is not a harmless act.

**What moves when a holiday is added** — the chain is short, and the last step is money:

| Step | What happens |
|---|---|
| 1 | That month's working days **D** go down (e.g. 26 → 24) |
| 2 | `dailyTargetSec = monthly target ÷ D` goes up (8.00h → 8.67h) |
| 3 | `monthly_summary`'s `target_sec` · `expected_sec` · `pace_sec` — all three change |
| 4 | The proration fraction `d ÷ D` changes → **the payroll deduction changes** |

**In the middle of a month this works backwards too** — the `pace` and `target`
of past days are recomputed with the new D. There is **not yet** a way to close
a month (payroll lock), so the calendar is the only guard.

#### The seed therefore does not apply anything to current or past months by itself

Future months are safe — those months have no `monthly_summary` rows yet, so
adding them moves nobody's figures. The seed adds those quietly.

Dates in the current or a past month are **held back**, and the seed prints
them **by name**:

```
⚠️⚠️ বসানো হয়নি: 2026-08-26 — "ঈদে মিলাদুন্নবী (সা.) (সম্ভাব্য)" (2026-08 মাসের হিসাব ইতিমধ্যে চলে গেছে)
⚠️⚠️ উপরের 18টি তারিখ বসালে ওই মাসগুলোর কর্মদিবস কমবে — target_sec · … (সরাসরি টাকা)।
```

(The seed output is in Bengali. In English: "not applied: <date> — <holiday name>
(that month's figures are already settled)" and "applying the 18 dates above
would reduce those months' working days — target_sec · … (directly money)".)

**It is not skipped silently** — "not applied" and "no need to apply" are not
the same thing, and the owner needs to know the difference.

#### When to run it

**The seed looks at the month, not the date** — there is no allowance for
"dates after today". A holiday on 26 August is held back on 14 August too,
because the working-day count **D** is for the whole month, and changing it
also changes the `pace` of that month's **past** days.

| When | What happens |
|---|---|
| Any day — **for future months only** | Always safe, no flag needed. Holidays for future months are added quietly |
| **On the 1st of the month, before work starts** | If the current month's must go in too, **this is the only tolerable time** — nobody has accumulated a single second yet that month, so changing D spoils nobody's figures. You still need the flag below, because the month counts as "current" |
| Mid-month | It can be run, but nothing for the current month is applied — the held-back dates are printed by name |
| Near month end, just before building payroll | The worst time — running with the flag changes the numbers at exactly the moment someone is reading them to pay money |

When new code arrives, run `vps-update.sh` — **it does not run the seed**, so
there is no need to think about the holiday list (§ 2.1a).

#### If you really must apply past dates

To apply the held-back dates deliberately, **once**:

```bash
cd /opt/oxeio/oxeio-monitor
docker compose --profile setup run --rm \
    -e SEED_HOLIDAYS_PAST=true migrate
```

It must be written exactly `true`. `1`, `yes`, `TRUE` — none counts as consent,
and the seed will print the dates again. **The mistake is not silent, it is
visible** — deliberately, because otherwise even writing `SEED_HOLIDAYS_PAST=false`
would count as "yes".

For just a few dates it is better to add them by hand in **Settings → Holidays**
— that way each decision is made separately, and you can see which one went in.

#### After applying — will the summaries catch up by themselves?

**Half.** The two cases are different, and must not be mixed up:

| Month | What happens |
|---|---|
| **Current month** | Catches up by itself. The `summary-refresh` job runs every 15 minutes (`0 5,20,35,50 * * * *`) and rewrites the current month's rollup |
| **Past month** | **Does not catch up by itself, and today there is no command or endpoint to make it** |

The `monthly_summary` rows of past months will stay with the old D — so the
`holidays` table and the figures will **disagree**, and nothing will show an
error anywhere. Then one day, when a time-adjustment for that month is approved
(`server/src/adjustments/adjustments.service.ts` → `refreshDate()`), the month
will suddenly be recomputed with the new D, and the figures will **jump** —
nobody will understand why.

**So the recommendation: do not apply past months' holidays at all**, unless you
intend to recompute that month's payroll. Once month-closing arrives this
question settles itself.

#### The 2027 dates are still **ungazetted**

The seed reminds you of this every time:

```
⚠️ 2027-এর 15টি তারিখ জ্যোতির্গণনার হিসাব — প্রজ্ঞাপন এখনো বেরোয়নি …
   নভেম্বর ২০২৬-এ প্রজ্ঞাপনের সাথে মিলিয়ে prisma/holidays.data.ts হালনাগাদ করুন।
```

(In English: "15 dates of 2027 are astronomical estimates — the gazette has not
been published yet … in November 2026, check against the gazette and update
prisma/holidays.data.ts.")

Those 15 dates **already** set the working days and targets of those 2027
months — so future targets rest on a guess. They are kept in the list anyway,
because saying "no holiday" is more wrong than saying "probably a holiday" — and
the name ends in `(সম্ভাব্য)` ("probable"), so it is visible on screen too.

**To do in November 2026:** when the gazette is out, correct the dates in
`server/prisma/holidays.data.ts`, then remove `2027` from that file's
`PENDING_GAZETTES` — otherwise the warning would keep sounding falsely, and
after a while nobody would read it.

#### 2026-03-17 — one row must be fixed by hand

The old seed put `জাতির পিতার জন্মদিন` ("Father of the Nation's birthday") on
that date (the day was dropped from the government's holiday list in 2024); the
new list has `শবে কদর (সম্ভাব্য)` ("Shab-e-Qadr (probable)") on it. The seed
**does not rename** a row when the date matches — deliberate, otherwise every
correction the owner made by hand would be wiped on the next seed.

Result: that row will **never** get the `(সম্ভাব্য)` ("probable") marker, i.e.
nowhere on screen will it show that the date depends on the moon. The seed says
this by name every time:

```
⚠️ একই তারিখ, আলাদা নাম: 2026-03-17 — DB-তে "জাতির পিতার জন্মদিন",
   তালিকায় "শবে কদর (সম্ভাব্য)" — seed নাম বদলায় না, তাই সারিটা কোনোদিন
   "(সম্ভাব্য)" চিহ্ন পাবে না; ঠিক করতে Settings → Holidays
```

(In English: "same date, different name: 2026-03-17 — the DB has "Father of the
Nation's birthday", the list has "Shab-e-Qadr (probable)" — the seed does not
rename, so the row will never get the "(probable)" marker; to fix, use
Settings → Holidays".)

**To do:** Settings → Holidays → the 17 March 2026 row → change the name to
`শবে কদর (সম্ভাব্য)`. Only the name — **do not delete the date or the row**,
otherwise March's working days change (the chain above).

### 2.1d· Outside Bangladesh

The seed writes Bangladesh's holidays and a 208 h / 26 day / Friday-off
policy unless told otherwise. Set these in `.env` **before the first seed**
(they are read only when the database is created):

```bash
SEED_COUNTRY=none                # no Bangladesh holidays
SEED_POLICY_MONTHLY_HOURS=176
SEED_POLICY_WORKDAYS=22
SEED_POLICY_WEEKLY_OFF=7         # ISO day (Mon = 1 … Sun = 7) or "none"
```

Then import your own calendar from an official CSV (`date,name,type`) or
ICS file. It goes through the same rule as the seed: dates in the current or
a past month are listed and left out unless you pass `--allow-past` (read
§ 2.1c first — they change targets and salary).

```bash
docker compose --profile setup run --rm migrate \
  npx tsx prisma/import-holidays.ts prisma/holidays.local.csv --dry-run
```

### 2.2· Starting the stack

```powershell
docker compose up -d
docker compose ps          # all three must be healthy
```

Three services: `postgres` · `api` · **`web`** (the dashboard, default port
`8080` — to change it set `WEB_PORT` in `.env`).

**The dashboard and API are on the same origin** — Caddy sends `/api/*` to the
api container and serves all the pages itself. So the session cookie
(`SameSite=Strict`) works and the CORS question never arises.

> Careful: there used to be no `web` service at all — the only way to run the
> dashboard was to keep `npm run dev` running by hand. After the server PC
> rebooted, the owner could see no page until someone opened a terminal and ran it again.

> Careful: `docker compose ps` now really says something: a healthcheck has
> been added to the api (`/api/v1/health` + `db: up`). Before, there was no
> healthcheck, so the column said "running" even while the app sat in a crash loop inside.

---

## 3· TLS — **on a VPS start here, not at § 3a–4**

Under ADR-026 the system will run **on a VPS**, i.e. there is a real domain —
so a self-signed certificate is not needed. **Let's Encrypt** is free, the
browser shows no warning, and no certificate has to be installed on any PC.

Careful: **§ 3a and § 4** below (self-signed) are needed only if the server
moves back to the office LAN or you test in dev.

### 3.1· Caddy fetches the certificate itself

The `web` service's Caddy automatically obtains and renews the certificate from
Let's Encrypt — just write the domain in the `Caddyfile`; no separate certbot is needed.

```
oxeio.example.com {
    reverse_proxy /api/* api:3000
    root * /srv
    file_server
}
```

**Set up DNS first** — if the domain's `A` record does not point at the VPS's
IP, Let's Encrypt cannot validate, and Caddy will keep retrying and failing.

**Installing on a phone (PWA) works only on HTTPS.** The dashboard can be added
to the phone's home screen (`web/public/manifest.webmanifest` + `sw.js`), but
browsers run service workers only on **HTTPS** or `localhost`. In production
`hub.oxeio.com` is on HTTPS, so it works properly there. Careful: on plain
`http://<IP>:8080` (the office LAN, before § 3a) "Add to home screen" will never
appear — the app still works fully, it just cannot be installed.

### 3.2· Pinning and renewal — the trap where everything stops after three months

The agent's `SERVERPIN` goes by the hash of the **SPKI**. Let's Encrypt
certificates are renewed every **90 days**, and by default a **new key** is
generated each time — a new key means a new SPKI, so **all 15 agents lose their
connection at once**, exactly three months later, with no warning.

**The simplest and safest way: do not set `SERVERPIN` at all.**

Pinning was mainly needed for **self-signed** certificates — there "whatever
Windows trusts" is weak, because anyone who can place a certificate in Trusted
Root can mount a MITM. A public-CA certificate has no such weakness. Without
`SERVERPIN`, pinning is simply off, and the agent says so plainly in its log.

Careful: if you still want pinning, do **both** of these:

1. Use certbot instead of Caddy, with `certbot renew --reuse-key` — the key
   stays the same, so the SPKI does too, and the pin need not change
2. Install two pins **before** renewal (`SERVERPIN` takes two comma-separated
   values — for exactly this reason)

---

## 3b· Behind a reverse proxy *(Traefik, Nginx, Cloudflare, Coolify …)*

The shipped setup assumes the `web` container (Caddy) is the edge: it holds
the certificate and the address it sees is the visitor's. Put another proxy
in front and Caddy sees **that proxy's** address for everyone, which breaks
two things quietly:

- the login rate limit at the edge (30 a minute) becomes one bucket for the
  whole world — after 30 attempts nobody can log in for a minute;
- the API's per-IP lockout (`LOGIN_IP_MAX_FAILS`) and the audit log's IP
  column record the proxy, not the person.

Tell Caddy which addresses are your proxy. Only requests from those are
believed about the client's IP; anyone else who sends the header keeps
their own address, so nobody can choose an IP to dodge the lockout.

```bash
# .env
CADDY_SITE=:8080                       # TLS is the proxy's job now
CADDY_TRUSTED_PROXIES=172.16.0.0/12    # the proxy's address(es), CIDR, space-separated
# CADDY_CLIENT_IP_HEADERS=CF-Connecting-IP   # only with Cloudflare directly in front
```

- With a proxy in a docker network on the same host (Traefik, Coolify), its
  address is in that network's range — `docker network inspect <net>`.
- With Cloudflare in front, list Cloudflare's ranges
  (<https://www.cloudflare.com/ips/>) and set `CADDY_CLIENT_IP_HEADERS`.
- Leave `TRUST_PROXY` (API) at its default `1`: Caddy hands the API one
  address, already decided, so the API still trusts exactly one hop.

Check: log in from two different networks, then Settings → Audit — the two
rows must show two different addresses, neither of them the proxy's.

## 3a· Making the certificate *(only for a LAN / self-signed setup)*

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 `
    -Hostname oxeio.office.local -IpAddress 192.168.0.10
```

If you give no name and IP, the script finds the machine's name and all its LAN
IPv4 addresses itself.

> Careful: **check the list** printed at the end. If the address the agent or
> browser will use is not in the SAN, the browser will not connect at all. So
> both the hostname **and** the LAN IP are included, not just one.

It is created in `deploy\certs\`:

| File | What |
|---|---|
| `oxeio-cert.pem` | Certificate → `TLS_CERT` |
| `oxeio-key.pem` | Private key → `TLS_KEY` — **secret** |
| `oxeio.pfx` | Both together — for importing into Windows and for renewal — **secret** |
| `oxeio-pin.txt` | SPKI pin — goes on the agent (§ 6) |

> Careful: `deploy\certs\` **does not go into git** (see `.gitignore`). Never
> commit the private key, and never send it by email. The SPKI pin, however, is
> not secret — it is the hash of the public key and can safely be sent.

### 3.1 For the browser — installing in Trusted Root

When the dashboard is opened, the browser will warn about the self-signed
certificate. On every PC from which the dashboard will be viewed, once (as admin):

```powershell
Import-Certificate -FilePath deploy\certs\oxeio-cert.pem `
    -CertStoreLocation Cert:\LocalMachine\Root
```

> Careful: only `oxeio-cert.pem` — **not `oxeio.pfx`**. The pfx contains the
> private key, and there is no reason to take it to another machine.

---

## 4· Turning on TLS on the server

In `docker-compose.yml`, add to the `api` service:

```yaml
  api:
    environment:
      TLS_CERT: /certs/oxeio-cert.pem
      TLS_KEY: /certs/oxeio-key.pem
      CORS_ORIGIN: https://oxeio.office.local
    ports:
      - "443:3000"          # was "3000:3000"
    volumes:
      - ./deploy/certs:/certs:ro
```

Careful: **the `transport` block in `web/Caddyfile` must also be uncommented** —
otherwise Caddy will send plain HTTP to the api, and that port no longer speaks
plain HTTP. The result: every dashboard request gets a 502, while the api's log
shows no error. The dev proxy fell into exactly this trap once (bug 4 in
[09 § ৩এ](../../docs/09-Build-Log.md)).

Then `docker compose up -d --build`.

How it works (`server/src/main.ts`):

| State | Result |
|---|---|
| Neither `TLS_CERT` nor `TLS_KEY` | HTTP (development, as before) |
| Both present | HTTPS |
| One present, the other missing | **The server will not start at all** |

> The third state is deliberately fatal. With a "run on whatever I got" policy,
> one typo (`TLS_KEY` vs `TLS_KEYFILE`) would silently drop the server to HTTP —
> everything would work, the dashboard would open, and the agents would keep
> sending their **device tokens in plaintext** over the LAN. For months nobody would notice.

To verify:

```powershell
docker compose logs api --tail 20     # should show "oXeio API https://0.0.0.0:3000"
curl.exe https://oxeio.office.local/api/v1/health --cacert deploy\certs\oxeio-cert.pem
```

If `{"status":"ok","db":"up",...}` comes back, the server is ready.

---

## 5· Firewall

### On a VPS — the API is now on the public internet

What was enough on the office LAN is not enough on a VPS. **Keep only two ports open:**

| Port | Why |
|---|---|
| `443` | Agents and the dashboard — the only one that is needed |
| `22` | SSH · **with a key, not a password** (`PasswordAuthentication no`) |

**Never open `5432`.** Postgres stays only inside the Docker network. An open
Postgres on the internet gets scanned within minutes, and inside it are 15
people's salaries and their whole work history.

The agent brute-force protection, 2FA and the `audit_log` — all three are
already in place, so the login door is as strong as on the LAN. Careful: but it
is now within reach of the whole world, so you **must** change
`SEED_OWNER_PASSWORD` and turn on 2FA on the owner account — this is no longer optional.

Careful: the disk 80%/95% alerts will really matter on a VPS — on an 80 GB disk
90 days of screenshots is ~22 GB, but if the retention job fails they will keep
piling up, and when the disk fills Postgres stops writing.

### On the office LAN



```powershell
New-NetFirewallRule -DisplayName "oXeio API (HTTPS)" `
    -Direction Inbound -Protocol TCP -LocalPort 443 `
    -RemoteAddress 192.168.0.0/24 `
    -Profile Domain,Private -Action Allow
```

> Careful: **do not pass `-Profile Public`**, and keep it restricted to the
> office subnet with `-RemoteAddress`. When a laptop goes onto a café's Wi-Fi,
> Windows treats that network as Public — with the port open on Public, anyone
> there could reach the server.
>
> Careful: do not open the database port (5432). In `docker-compose.yml` it is
> deliberately bound to `127.0.0.1`.

---

## 5a· Screenshots in an S3-compatible bucket *(optional)*

By default screenshots and thumbnails are files under `STORAGE_HOST_PATH`.
With `STORAGE_DRIVER=s3` they go to a bucket instead — Backblaze B2, MinIO,
AWS or any S3-compatible store — and this disk keeps only the database, the
backups and the agent installers.

```bash
# .env — Backblaze B2 example
STORAGE_DRIVER=s3
S3_BUCKET=oxeio-screenshots          # private bucket
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_REGION=us-west-004
S3_ACCESS_KEY_ID=…                   # an application key limited to this bucket
S3_SECRET_ACCESS_KEY=…
```

What stays the same:

- the bucket stays **private**. The dashboard keeps using the server's own
  signed links (5 minutes); the server reads the object and streams it, so
  no public URL, CORS rule or bucket policy is needed;
- retention (90 days) deletes from the bucket, image and thumbnail;
- the server writes and deletes a probe object at startup and refuses to
  start if it cannot — a wrong key shows up at once, not as missing
  screenshots a week later;
- Settings → Health shows where screenshots go and whether the bucket
  answers. The disk alert keeps watching this disk (database, backups).

⚠️ Switching an existing install does not move old screenshots: rows keep
their paths, and the gallery looks for them in the bucket. Copy the
`screenshots/` folder to the bucket first (same paths, under `S3_PREFIX` if
set), e.g. `rclone copy .data/storage/screenshots b2:oxeio-screenshots/screenshots`.

## 6· Pinning the certificate on the agent

This is the most important part of this document.

### 6.1 Why there is no way around pinning

The certificate is self-signed. So when the agent's `HttpClient` tries to
verify TLS the normal way it **will fail** — there is no known CA at the head of
the chain. That leaves three paths:

| Path | Result |
|---|---|
| Turn verification off | **Never** — see below |
| Install the certificate in every PC's Trusted Root | Works, but at renewal it means 15 PCs again |
| **Pinning** | This is it |

Why "verification off" is dangerous: the agent sends its **device token** with
every request (`Authorization: Bearer …`). With verification off, anyone on the
LAN (ARP spoofing, a rogue Wi-Fi router, or just tampering with DNS) can sit in
the middle and present their own certificate — the agent will happily hand over
the token. With that token they can inject fake work hours, or read screenshot
uploads. **That is, TLS would give no benefit at all.**

Pinning means: the agent knows in advance which **public key** the server has,
and cuts the connection straight away if it sees anyone else's certificate.

### 6.2 What the pin is

What `make-cert.ps1` prints — the SHA-256 of the public key (SPKI), in base64:

```
1+iBMimAAGEKtj350WUD1nVmSpLSqXw6/KrjLD/ILo4=
```

> It is the hash of the **key**, not of the **certificate**. This is the central
> decision: when the certificate is renewed the certificate's hash changes, but
> if the key is kept the same the SPKI hash **does not change**. So on renewal
> day none of the 15 PCs needs touching (§ 7). Pinning the certificate's
> thumbprint would take the whole fleet down at every renewal.

### 6.3 How the pin reaches the agent

Like `SERVERURL` — as an MSI property, into the registry:

```
HKLM\SOFTWARE\oXeio\Agent\ServerPin  (REG_SZ)
```

The MSI needs a `SERVERPIN` property (right beside `SERVERURL` in
`agent/installer/Package.wxs`), and `AgentSettings` needs a `ServerPin` field.

> **None of this had been built yet — checked and found so at the time.** There
> was no `SERVERPIN` property in `Package.wxs`, no `ServerPin` field in
> `AgentSettings`, and no certificate-verification code anywhere in the agent.
> `make-cert.ps1` does print the pin, but that is **for this future feature** —
> then, that value had no consumer. So at that point the agent verified the
> server's certificate **with Windows' own trust store**, not with a pin — if
> you use a self-signed certificate it first has to be installed in the trust
> store (§ 4). (The code has since been written — see the note under § 6.4.)

> **The pin must never be downloaded from the server.** An attacker in the
> middle would then simply send their own pin, and the whole scheme would be
> meaningless. The pin arrives at install time, as a value given by hand — that
> is the trust anchor.

> **Provide for more than one pin** — a comma-separated list. If the private
> key ever has to change (§ 7.2), you can first distribute two pins (old +
> new), then change the certificate, then drop the old one — the fleet is never
> down at any moment. If only a single pin were supported, on the day the key
> changed all agents would stop at once.

### 6.4 Where it goes in the code

`SslOptions` has to be added to the `SocketsHttpHandler` in
`agent/src/oXeio.Agent/Sync/HttpSyncClient.cs`. The structure is like this:

```csharp
var inner = new SocketsHttpHandler
{
    // … all earlier settings unchanged …

    SslOptions = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (_, cert, _, _) =>
        {
            if (cert is null) return false;

            using var c = new X509Certificate2(cert);
            var spki = c.PublicKey.ExportSubjectPublicKeyInfo();
            var hash = SHA256.HashData(spki);

            // pins = comma-separated list read from the registry
            return pins.Any(p => CryptographicOperations.FixedTimeEquals(
                hash, Convert.FromBase64String(p)));
        },
    },
};
```

A few things to keep in mind:

- Installing this callback means **all of .NET's own verification is turned
  off** — hostname matching, chain, expiry, everything. Whatever is needed has
  to be done here yourself. Writing `return true` without understanding this is
  the easiest mistake, and it brings back the whole danger of § 6.1.
- Decide in advance what happens **when there is no pin**. Recommendation: for
  `https://` the pin is mandatory, and if the agent gets a config without a pin
  it should not connect and should show a clear error in the tray. "No pin
  means skip verification" — that default would one day silently take away
  everyone's security.
- `AgentSettings.IsUsable` currently accepts `http://` as well. In production
  with a pin, `http` should be **rejected** — otherwise if someone mistakenly
  writes `http://`, the token would travel in the open despite pinning.
- `FixedTimeEquals` is not essential for security here (the pin is not secret),
  but it is a good habit — and costs nothing.

> **This code has now been written** — the design above went into
> `Sync/HttpSyncClient.cs`, but the decision itself was moved into
> `Core/Agent/CertificatePin.cs`. Sitting inside the TLS handler, verifying it
> would need a real certificate, a real MITM and a test server; as a pure
> function it is covered by **15 unit tests** — the most important being:
> *"pin matches, but the chain is broken → rejected"*.

### 6.5 What the agent does when the certificate expires

Recommendation: **the agent does not check expiry** — it only matches the pin.

The reason: the pin is the trust anchor here, and expiry adds nothing to it
(if the key leaks there is no point waiting for expiry — the key has to be
changed, § 7.2). On the other hand, checking expiry would make **15 PCs stop
sending data at once** on a forgotten date, and it would be noticed very late —
because the agent quietly keeps queuing, it does not fall over.

But expiry **is still needed for the browser** — opening the dashboard will
show a warning. That will in practice be the nudge to renew.

---

## 7· Certificate validity and renewal

The default validity is **825 days** (~2 years 3 months).

> Why not 398 days: the browsers' 398-day limit applies to chains from public
> CAs, not to a certificate you place in Trusted Root yourself. And renewing
> every year means a chance to forget every year.

### 7.1 Regular renewal — nobody will even notice

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-cert.ps1 -ReuseKey
docker compose restart api
```

`-ReuseKey` uses the same private key as before, so:

- The SPKI pin is **unchanged** → nothing has to change on the agents
- The `oxeio-key.pem` file is **not touched at all**
- Only the certificate, pfx and pin.txt are new

Then, on the browser PCs, § 3.1 once more (the new certificate into Trusted Root).

> **Mark the calendar — 60 days before expiry.** The date is written in
> `deploy\certs\oxeio-pin.txt`.

### 7.2 When the key has to change (if the key leaks)

This is the only situation where the 15 PCs have to be touched. The order matters:

1. New key + certificate: `make-cert.ps1 -Force` → a new pin
2. Distribute **two pins** (old, new) to the agents — in the registry
3. Confirm that all agents have received the new pin
4. Only then put the new certificate into service on the server
5. After a few days, drop the old pin from the list

> If 2 and 4 are swapped, the fleet will go down.

---

## 8· Delivering the MSI — the simplest path

### 8.1· Building the MSI (once, on the server PC)

```powershell
powershell -File agent\installer\build.ps1
```

### 8.1a· Signing *(not optional — needed to avoid the dialog)*

```powershell
# Once, on the server PC — prints the thumbprint
powershell -ExecutionPolicy Bypass -File deploy\make-code-cert.ps1

# Then on every build
powershell -File agent\installer\build.ps1 -SignWith <thumbprint>
```

**And once on every staff PC** (as admin), otherwise the signature will be
there but Windows will not recognise it:

```powershell
powershell -ExecutionPolicy Bypass -File deploy	rust-publisher.ps1
```

The script installs the certificate in **two** stores — Trusted **Root** and
Trusted **Publishers**. A purchased certificate does not need the first, but a
self-signed certificate is its own issuer, so without Root the chain stays
broken and the dialog keeps appearing ([ADR-014](../../docs/05-Options-Decisions.md)).

If `deploy\certs\oxeio-code.pfx` is **lost, nothing can be signed with the same
identity again** — you would have to go to the 15 PCs again to install a new
`.cer`. Keep a backup.

Without `-SignWith` the build works as before, only the install shows
"Unknown publisher". The end of the build says whether it was signed.

---

**The address is baked into the MSI itself** — then on each PC it is just a
**double-click**. There is no need to type a long command on 15 machines, and
no risk of one machine sitting dead silently because of a typo.

The default address is `https://oxeio.office.local`; for anything else use
`-ServerUrl "https://…"`. To get an MSI **without** an address you now have to
ask explicitly — `-NoServerUrl`, and then every machine needs `msiexec /qn
SERVERURL=…`. Careful: this used to be the default, and if you forgot to pass
`-ServerUrl` the build silently produced an MSI that, on double-click, stopped
with *"This MSI was built without a server address"* — exactly that happened
with 0.3.2 ([09 § ৩ন](../../docs/09-Build-Log.md)).

Careful: **do not write `/api/v1`** in `-ServerUrl`, and no trailing slash
either — the agent appends it itself. The script checks the shape, and the
build stops if it is wrong.

`pwsh` (PowerShell 7) is **not** needed — it runs on stock Windows PowerShell
5.1. (That is why the file needs a UTF-8 BOM; see "About the scripts" below.)

There is also no need to pass `-Version` — the number comes from
`agent/Directory.Build.props`. If given by hand, the MSI would install one
version and the agent's heartbeat would report another.

### 8.1b· Signed agent updates *(recommended)*

Agents check a downloaded update against the sha256 the server reports —
which catches a broken download, but not a server that has been taken over:
whoever controls it can serve another MSI with its own matching hash, and an
update runs as administrator on every PC. With an update key, a PC installs
only MSIs signed with a private key that **never sits on the server**.

**Once — make the key pair, on your own machine (keep `update-key.pem` offline):**

```bash
openssl ecparam -name prime256v1 -genkey -noout -out update-key.pem
openssl ec -in update-key.pem -pubout -out update-key.pub.pem
```

**Build MSIs with the public key baked in** — every PC installed from it, and
every update built the same way, keeps the key:

```powershell
powershell -File installer\build.ps1 -UpdatePublicKey update-key.pub.pem
```

**Every release — sign the exact MSI and put the signature next to it:**

```bash
openssl dgst -sha256 -sign update-key.pem -out oXeioAgent-0.5.0.msi.sig oXeioAgent-0.5.0.msi
```

Copy both files to the server's `updates/` folder and publish as usual; the
server stores the signature and passes it to the agents. Set
`AGENT_UPDATE_PUBLIC_KEY` (the one-line base64 body of `update-key.pub.pem`)
in `.env` too: the server then refuses to publish an MSI whose signature is
missing or wrong, instead of letting every PC download and discard it.

- PCs without a key (installed before, or from an MSI built without
  `-UpdatePublicKey`) keep checking the hash only, as before.
- A refused update shows in the agent log as `Update … refused — …`, and the
  file is deleted.

### 8.2· On each PC

Double-click the MSI **as admin**. That is all.

Careful: the version is in the file name — `oXeioAgent-0.3.4.msi`. Old builds
also stay in `bin/`, so **you can tell by the name which one you are
distributing**. Once, three different binaries went out under the same name,
and there was no way to say which was which ([09 § ৩থ](../../docs/09-Build-Log.md)).

Careful: admin is needed because the files go into `Program Files`, the config
goes into `HKLM`, and a logon Scheduled Task is installed.

Then **the staff member themselves** will see a window:

> **Sign in to start tracking**
> https://oxeio.office.local
> Work email · Password

They enter their own email and password (the same ones they use for the
dashboard), and the device is added **in their own name**.

**Why this path is better than the enrollment code:** with codes, a separate
code had to be created for each PC, used within 24 hours, and **which code
went to which machine** had to be matched by hand. A wrong match raised no
error — one person's hours would accumulate under another's name, and be
caught only at month end. Now **the person at the keyboard proves for themselves who they are**.

Careful: **the staff member's portal account must be created beforehand** —
dashboard → Settings → Staff → that staff member → "Portal account". The
temporary password is shown only once; hand it to them. (The account is needed
anyway — it is what they use to see their own hours, `/me`.)

Careful: if the window is closed the agent keeps running, it just sends
nothing — it will ask again at the next logon. Also, you cannot sign in with an
owner or manager account; the message says exactly that.

### 8.3· Scripted rollout (nobody sits at a keyboard)

The code path is still there — for installing on 15 PCs remotely at night:

```powershell
msiexec /i oXeioAgent-0.3.4.msi /qn `
    SERVERURL="https://oxeio.office.local" `
    ENROLLCODE="XXXXXXXXXXXX" `
    PORTALURL="https://oxeio.office.local/me" `
    POLICYURL="https://oxeio.office.local/policy"
```

Careful: `SERVERURL=` on the command line **overrides** the value baked into
the MSI — so one MSI can serve two servers.

**`SERVERPIN` works now** — after installing the certificate, add the pin:

```powershell
msiexec /i oXeioAgent-0.3.4.msi /qn `
    SERVERPIN="<the base64 value make-cert.ps1 prints>"
```

> Careful: this used to say *"pinning has not been built yet"* — that is no
> longer true. `Package.wxs` now knows five properties, and the agent really
> verifies with `CertificatePin`.
>
> Careful: **without a pin, pinning is off** — then only Windows' own
> verification applies, and for a self-signed certificate that is weaker than it
> sounds. The agent says so plainly in its log (`logs\agent.log`). The
> recommendation in § 6.4 was to make the pin **mandatory**; that was not done,
> because the pilot machines (where the certificate was never installed) would
> then not be able to connect at all. Providing the pin in production is part of
> the rollout checklist.

> Careful: **each PC needs a different** `ENROLLCODE` — a code is single-use.

---

## 9· Enrollment code *(needed only for the scripted rollout)*

Careful: for an ordinary install this is **not needed** — see § 8.2. This
section exists only for § 8.3.

In the dashboard log in as **owner** → Devices → "New code"
(`POST /api/v1/devices/enrollment-code`).

- 12 characters, with look-alike characters left out (no `0`/`O`, `I`/`L`)
- Expires after **24 hours**
- Can be used **only once**

> Careful: do not create 15 codes in advance — made today and used the day
> after tomorrow, you will find them all expired. Take a PC's code on the day
> you install that PC.

---

## 10· Antivirus exclusion

On every staff PC, **after installing the agent**:

```powershell
# 1. Look first — nothing will change
powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1 -WhatIf

# 2. Then for real (as admin)
powershell -ExecutionPolicy Bypass -File deploy\defender-exclusions.ps1
```

To run it from a rollout script without prompts, use `-Force`.

> Careful: `-Confirm:$false` **will not work** — `powershell -File` treats every
> argument after it as a string, so `$false` becomes the literal `"$false"`.
> That is why there is a separate `-Force` switch.

By default it adds: `oXeio.Agent.exe`, `oXeio.Watchdog.exe` (processes) and
`C:\Program Files\oXeio` (a folder).

> `%ProgramData%\oXeio` is deliberately **left out**. Ordinary users have write
> access to that folder (the agent has to run under the staff member's account),
> so if it were excluded, anyone in the office could drop an .exe there and
> Defender would no longer see it — effectively a "place to hide a virus". The
> two process exclusions already keep the agent's own files out of scanning, so
> it is not needed anyway. Use `-IncludeDataFolder` only if you really see slowness.

> Careful: if another antivirus (Kaspersky, Avast, …) is running, Defender is
> inactive — the script detects this and gives a clear message. Then the same
> folder and processes must be added to the exclusion list from that AV's own console.

After an uninstall: `-Remove`.

---

## 11· What to check on the first day

### Morning (right after installing the agents)

- [ ] The oXeio icon is **visible** in every PC's system tray
      (this is not a covert install — if the icon is not shown, that is a bug, not a feature)
- [ ] **All 15 machines** are on the dashboard's Live Board
- [ ] Nobody shows "enrollment failed"
- [ ] Staff can open tray → "Today's hours" themselves

### Noon

- [ ] Work hours are increasing, not stuck
- [ ] Screenshots are arriving
- [ ] App usage shows **only the domain**, not the full URL
      (stop immediately if you see a full URL — it breaks a hard rule of the product)

### Afternoon / next morning

- [ ] `%ProgramData%\oXeio` is not growing (an outbox that is not piling up
      means uploads are happening)
- [ ] No screenshots arrived after 11 pm, but **time counting continued**
      (07:00–23:00 is only the screenshot window, not the hours window)
- [ ] There are no screenshots before 7 am
- [ ] `docker compose logs api` — no error repeating over and over

### End of the week

- [ ] The progress towards the monthly 208 hours looks reasonable
- [ ] Backups are running
- [ ] The signed policies are filed in order

---

## 12· When something goes wrong

| Symptom | Likely cause |
|---|---|
| Agent not connecting, tray red | The pin does not match (was the order in § 7.2 reversed?), or the firewall |
| Certificate warning in the browser | § 3.1 was not done, or the certificate has expired |
| `curl` says hostname mismatch | The name you are calling is not in the SAN — recreate the certificate with `-Hostname`/`-IpAddress` |
| Server will not start, "TLS is only half configured" | One of `TLS_CERT` or `TLS_KEY` is missing |
| Server will not start, "Could not read" | `/certs` is not mounted in the container, or the path is wrong |
| A machine shows "offline" on the Live Board although it is on | The clock is out of sync, or the outbox is draining |
| **The gallery has rows but every image is broken** | The container cannot write to the storage folder — see § 12.2 below |
| **A staff member cannot log in, and a reset does not work either** | The staff member was once deactivated — the login never came back, see § 12.3 below |
| **`ssh: Connection timed out`** | The server is probably running fine — only the route to port 22 is blocked, see § 12.4 below. Careful: this is exactly what happened once, and the fault was the **ISP's**, not the server's (§ 12.4a) |

Logs:

```powershell
docker compose logs api --tail 100
Get-Content "$env:ProgramData\oXeio\logs\agent.log" -Tail 50   # on the agent's PC
```

Careful: the path is in the `logs\` subfolder — it used to say `oXeio\agent.log`
here, and that file was **never written**. On the agent's PC that folder holds
three things:

| File | What |
|---|---|
| `agent.log` | Everything from today — startup, each slot's capture, sync errors |
| `agent-YYYY-MM-DD.log` | Earlier days (7 days, 50 MB in total) |
| `outbox-drops.log` | What was dropped from the queue for good |

### 12.2· Rows exist, images do not

Symptom: the gallery says *"10 this day"*, but every one is a broken icon; the
Live Board says *"Link expired — refresh"*.

**The row and the file are written in different places** — DB first, disk
second. If the disk write fails the row stays, and when the agent retries the
DB says "duplicate", the server returns **success**, and the agent deletes the
image. No alert is raised anywhere ([09 § ৩স](../../docs/09-Build-Log.md)).

The cause is almost always one thing: the host's `.data/storage` folder belongs
to **root**, while the container runs as `node` (uid 1000). Careful: the
Dockerfile's `chown -R node:node /data/storage` does **not help** here — a bind
mount covers the image's folder, ownership included.

To confirm in one command:

```bash
docker compose exec -T api sh -c 'id; ls -ld /data/storage; touch /data/storage/.probe && echo OK || echo DENIED'
```

The fix:

```bash
chown -R 1000:1000 .data/storage && docker compose restart api
```

Careful: **the earlier broken images will not come back** — they were never
written to disk. You will know it is fixed when a new image arrives in the next capture slot.

### 12.3· A staff member cannot log in although the password reset "succeeded"

Symptom: on the Staff screen the staff member is **Active**, "Reset password"
gives a new password, yet login always says *"Email or password is incorrect"*.

Think back whether the staff member was ever **deactivated and then
reactivated**. Deactivating set `users.is_active = false`, but reactivating did
not restore it ([09 § ৩ঢ়](../../docs/09-Build-Log.md)).

To find who is in this state — staff active, yet login disabled:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select u.email, e.emp_code, e.full_name from users u join employees e on e.id = u.employee_id where u.is_active = false and e.status = '"'"'active'"'"'"'
```

Careful: **the new code does not repair old rows** — it only keeps things right
from now on. And the UI cannot repair it either: the staff member is now
`active`, so "Reactivate" returns 409. It has to be fixed by hand, once:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update users set is_active = true where employee_id in (select id from employees where status = '"'"'active'"'"') and is_active = false"'
```

After that **Reset password** is no longer needed — the old password will work.
If it is not remembered, reset it then.

### 12.1· Owner cannot log in (lost password or phone)

Careful: this system has **no "forgot password" email link**, and that is
deliberate — it is a server inside the office, with no outside mail dependency.
So if the only owner loses the password or the 2FA phone, there is exactly one
way back: the server's shell.

```powershell
docker compose exec api node dist/scripts/recover-owner.js --list
```

```powershell
docker compose exec api node dist/scripts/recover-owner.js --confirm
```

- **Nothing changes without `--confirm`** — it cannot be run by mistake
- If there are several owners, say which with `--email owner@office.local`
- A new password is **generated** and shown on screen only once
- If 2FA was on it is removed too — log in and turn it on again
- The new password will be demanded at the first login
- Careful: the action is recorded in `audit_log` as `reset_password · via: cli`

Careful: if there is not a single owner account (after restoring the database,
or if someone deleted it by mistake) a new one can be created:

```powershell
docker compose exec api node dist/scripts/recover-owner.js --confirm --email owner@office.local
```

---

### 12.4· `ssh: connect to host … port 22: Connection timed out`

**Do not panic first — the server being down and SSH being unreachable are not
the same thing.** One command shows the difference (Windows PowerShell):

```powershell
foreach ($p in 22,80,443) { $r = Test-NetConnection <VPS_IP> -Port $p -WarningAction SilentlyContinue; "{0,-4} {1}" -f $p, $r.TcpTestSucceeded }
```

**80/443 open but 22 closed** means the machine is alive, the web server is
responding, and staff hours and screenshots are being collected — only you
cannot get in. Only when all three are closed is the machine or network
completely down.

**Then: whose fault is it — your network's, or the server's?**

```powershell
Test-NetConnection github.com -Port 22
```

A completely different host, whose port 22 is always open:

| Result | Meaning | What to do |
|---|---|---|
| `False` | **Your network/ISP** is blocking outbound 22 | § 12.4a below — this is what actually happened |
| `True` | The blockage is **on the server** — ufw or sshd | You need the web console, § 12.4b |

#### 12.4a· The ISP is blocking it — how to **prove** it

If the test above gives `False` the suspicion is almost certain, but the full
proof comes from **knocking on the server's other ports** — which nobody usually does:

**Do not use `Test-NetConnection` here.** It says only yes/no through
`TcpTestSucceeded` — it shows **both timeout and refused as `False`**, yet the
whole diagnosis rests on exactly that difference. You need a raw `TcpClient`
(the labels it prints are in Banglish: `timeout` = "silently vanished",
`refused` = "reached the server"):

```powershell
foreach ($p in 21,22,25,2222,3306,9999) { $c = New-Object Net.Sockets.TcpClient; $t = $c.BeginConnect('<VPS_IP>', $p, $null, $null); if (-not $t.AsyncWaitHandle.WaitOne(5000)) { $r = 'timeout   <- nirobe gayeb' } else { try { $c.EndConnect($t); $r = 'OPEN' } catch { $r = 'refused   <- server porjonto pouchheche' } }; $c.Close(); "{0,-6} {1}" -f $p, $r }
```

The same thing from a Mac or Linux:

```bash
for p in 21 22 25 2222 3306 9999; do printf "%-6s " "$p"; nc -z -v -G 5 <VPS_IP> "$p" 2>&1 | tail -1 | sed 's/.*: //'; done
```

**Read one line first, which gives half the answer for free** — if you can get
in from another machine (or through the console), SSH itself prints:

```
Last login: Thu Aug 13 07:59:53 2026 from 103.61.240.151
```

Compare that IP with your **current** IP (`curl ifconfig.me`). Once they did
not match, and that is what made the whole thing clear:

| From where | ISP | Port 22 |
|---|---|---|
| **Office** | HelloTech (AS138640) | open |
| **Home** | AmberIT (AS23956) | blocked |

> **Do not assume from "it used to work" that the environment was the same.**
> The office and home internet belong to different companies — one has 22 open,
> the other closed. So the first question is not "what changed" but **"where were you then"**.

The difference is in **timeout versus refused**, not open versus closed. What
was measured in the field:

| Port | Result | Meaning |
|---|---|---|
| 21 · 2222 · 3306 · 8080 · 9999 · 22222 | **Connection refused** | The packet **reached** the server, and the server said "no" with an RST |
| **22** · **25** | **timeout** | Vanished silently — it never reached the server |

**Ten random ports get through, only 22 and 25 do not** — there is one
explanation: the blockage is **before** the server. And **the 22 + 25 pair is
the signature of an ISP filter** (25 to stop spam, 22 in the name of "security").

> **If the server sends an RST on a port by itself, it is awake.** So "all
> closed" and "only two closed" are not the same — the second is always the
> path's fault, not the destination's.

This also **gives away ufw's state**: with ufw on, 3306 or 9999 would be
silently DROPped, i.e. show timeout. Showing refused means **no firewall is
running on the host** — see § 12.4c after getting in.

**Three ways in, whichever you can do first:**

| | Way | When |
|---|---|---|
| 1 | **Turn on a VPN** — Cloudflare WARP (the 1.1.1.1 app), free | Immediately. Inside the tunnel the ISP does not even see the port number |
| 2 | The phone's **hotspot** | If you have mobile data |
| 3 | The hosting panel's **web console** | If neither of the above works |

#### 12.4b· The web console — exactly where, step by step

**The provider is IT Nut Hosting**, not IOFlood — IOFlood (AS53755, Phoenix) is
only the datacenter above, and the IP range is theirs. Deciding the provider
from `whois`/`ipinfo` makes this mistake: **who you bought from and whose
datacenter it sits in are two different things.** The ticket has to go to the first.

The path:

```
<hosting panel>  →  Services → Manage Product
                          →  Actions → Enduser Panel      (Virtualizor)
<Virtualizor panel>:4083  →  Settings → VNC → Launch VNC
```

**VNC is not a port, it is inside HTTPS** — so the console opens even when the
ISP blocks 22. It opens in a **popup window**; if Chrome blocks it, allow it
from the icon at the right of the address bar.

Careful: on the way there are also **Reboot · Stop · Poweroff · Reinstall OS ·
Rescue Mode** buttons. None of them is needed to reach the console — if pressed
by mistake the server goes down and staff hours stop accumulating too.

Check the panel's **Firewall → Firewall Plans**. *"No Firewall Plans"* means
nothing is blocked on the provider's side — then the blockage is certainly in
the ISP's or inside the host.

Once in, look for the cause (without pipes — see § 12.4d for why):

```bash
systemctl status ssh --no-pager
```

```bash
ss -tln
```

#### 12.4c· Once in, the permanent fix — an alternative port *(proven in the field)*

You cannot change the ISP, but **you can move the door**. Packets to 2222
already reach the server (see the table above), so if sshd listens there you can
get in from the office without a VPN.

### But on Ubuntu 22.10+ `sshd_config` alone is not enough

```bash
systemctl is-enabled ssh.socket
```

If it says `enabled`, SSH is running through **systemd socket activation** — so
which port it listens on is decided by `ssh.socket`, **not `sshd_config`**.

This is the quietest trap in this job: the `Port 2222` line would go into the
file, `sshd -t` would stay silent, `systemctl restart ssh` would say green — and
**nothing would listen** on 2222. Not a single error would appear anywhere.

> **Written in a config file and actually in effect are not the same thing.**
> The file that decided things until now can one day get another layer put on
> top of it by the distro — and a command written from old habit then looks
> successful and does not work.

So turn off the socket and go back to classic sshd:

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
```

```bash
echo Port 22 >> /etc/ssh/sshd_config
```

```bash
echo Port 2222 >> /etc/ssh/sshd_config
```

```bash
sshd -t
```

**It is good if this line says nothing** — silence means the config is fine. If
it says anything, stop and go back with `cp /etc/ssh/sshd_config.bak /etc/ssh/sshd_config`.

```bash
systemctl disable --now ssh.socket
```

```bash
systemctl enable --now ssh
```

```bash
systemctl restart ssh
```

```bash
ss -tln
```

**Keep the `Port 22` line too.** With no `Port` at all in `sshd_config` the
default is 22, but as soon as you write one the default goes away — writing
only `Port 2222` would close 22, and typing `ssh root@…` from habit on another
network would not work.

**What we want to see** — exactly this came back in the field:

```
LISTEN 0 128  0.0.0.0:22      ← the old door, left open
LISTEN 0 128  0.0.0.0:2222    ← the new door
LISTEN 0 4096 127.0.0.1:5432  ← postgres, inside only (§ ৩শ trap 2)
LISTEN 0 4096 127.0.0.1:3000  ← api, inside only
LISTEN 0 4096 0.0.0.0:80 · :443 ← Caddy
```

**Check the last three rows separately too** — if `5432` or `3000` were on
`0.0.0.0`, the database and API would be open to the whole internet.

Then from the office:

```bash
ssh -p 2222 root@<VPS_IP>
```

**One line to confirm from outside** (Mac/Linux) — if a banner comes back you
know sshd is really answering, not just that the port is open:

```bash
nc -w 6 <VPS_IP> 2222
```

**And the firewall.** Careful: it was found that `ufw` was **not even
installed** (`Command 'ufw' not found`) — so do not wait to run `ufw status`
and see "inactive", install it directly:

```bash
apt-get install -y ufw && ufw allow 22/tcp && ufw allow 2222/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable && ufw status verbose
```

**Do not run `ufw enable` before opening `2222`.** If the order is reversed
the door you have just built will be closed, and 22 is already blocked by the
ISP — then the only way back is the web console. In the line above `enable` is
**last**, deliberately.

Do this step **while logged in over SSH, not VNC** — once 2222 is working,
copy-paste works in the terminal, and the trouble in § 12.4d below is avoided too.

#### 12.4d· `>` and `|` cannot be typed in the VNC console

In noVNC **shift works on letters** (`ABC` comes out right), but **not on
symbols**: `>` becomes `.`, `|` becomes `\`. Ctrl does not get through either —
`Ctrl+C` types a plain `c`, so you cannot even leave `nano`/`vi`.

The most dangerous form is silent: `echo Port 2222 >> file` becomes
`echo Port 2222 . file` — the shell gives **no error**, just prints the text,
and nothing is added to the file.

What **can** be typed: letters · digits · `- = / . , ; ' \ [ ]`
A way to add a line without a redirect — `sed` with a line number, needing not
one shifted symbol:

```bash
sed -i -e '1iPort 2222' /etc/ssh/sshd_config
```

This happens only with **machine-driven** keystrokes (browser automation). Typed
by hand on a real keyboard, noVNC reads it fine — the owner's hand-typed `>>`
went in correctly.

### 12.5· Logging in without a password (an SSH key)

Typing the root password again and again, or sending it to someone — both can
be avoided. Once a key is installed, the password is needed nowhere:

```powershell
ssh-keygen -t ed25519 -C "oxeio-admin" -f "$env:USERPROFILE\.ssh\oxeio"
```

Install the public part (`oxeio.pub`) on the server — this can also be done
through the web console:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && nano ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Then:

```powershell
ssh -i "$env:USERPROFILE\.ssh\oxeio" root@<VPS_IP>
```

**Do not turn off password login before you have confirmed that the key
works.** If you set `PasswordAuthentication no` and the key is wrong, the only
way back is the web console — and you will have to hunt for it at exactly the
moment you have no time.

Never send the root password in chat, email or a messenger. If you already
have, **change it at once with `passwd`** — even if you delete that message you
cannot know where copies have ended up.

---

---

## R4 · External uptime monitoring

**Why this cannot be done in code:** if the server itself dies it cannot send
its own alert. This blind spot in all the internal alerting can be covered only
by an outside eye — and so this is the one job that lives outside this repo.

### The mistake that is easiest to make here

`/api/v1/health` **returns HTTP 200 even when the database is dead** — it only
writes `"status":"degraded"` in the body:

```json
{"status":"ok","db":"up","time":"…","build":"233","commit":"f93e0d1"}
```

This is deliberate: the same route is used by Docker's healthcheck, and if it
returned 503 a database problem would put the container in a restart loop —
which fixes nothing and only loses the logs.

**The consequence:** if the monitor looks only at the **status code**, it will
show "UP" forever even with the database lying dead. The monitor itself would
then be the biggest lie — it will not catch exactly what it was installed to catch.

**So the monitor type is "Keyword", not "HTTP(s)".**

### Steps — ~10 minutes, free tier

1. A free account at **uptimerobot.com** (50 monitors, every 5 minutes).
   This is the owner's own account — the owner has to sign up.

2. **Add New Monitor:**

   | Field | Value |
   |---|---|
   | Monitor Type | **Keyword** *(not HTTP(s) — read the reason above)* |
   | Friendly Name | `oXeio — API` |
   | URL | `https://hub.oxeio.com/api/v1/health` |
   | Keyword Type | **Exists** |
   | Keyword | `"db":"up"` |
   | Interval | 5 minutes |

   `"db":"up"` was chosen over `"status":"ok"` — both would work, but the
   first also tells you **what broke**.

3. **Alert Contact — Telegram:** Settings → Alert Contacts → Add →
   Telegram → add the bot and give the chat id. Keep it in the same chat the
   app's alerts go to — if they are in two different places, nobody looks at one of them.

4. **Verify:** after setting up the monitor, run `docker compose stop postgres`
   on the VPS for a minute and see whether the news arrives on Telegram, then
   `start`. **Do not skip this step** — an alert that has never been
   triggered on purpose is not an alert. This project learned exactly this
   lesson once with backups.

### A second monitor — the web

| Field | Value |
|---|---|
| Monitor Type | HTTP(s) |
| URL | `https://hub.oxeio.com/` |

It is kept separate because Caddy can stay alive while the API dies (and the
other way round) — one monitor would not catch the difference between the two.


## R5 · Offsite backup

The nightly dump is written encrypted to `.data/backups` — but **all on one
machine**. If that disk dies or the VPS is lost, the backup goes with it, i.e.
**having** a backup and being able to **use** a backup are not the same.
`deploy/offsite-backup.sh` closes that gap.

**The files are already encrypted** (`BACKUP_PASSPHRASE`, `openssl enc`). So
wherever you upload them (Drive/S3), the provider can read nothing of the
hours, salaries or screenshots — this does not conflict with a "data must not
leave the country" policy.

**But if the passphrase is lost, the backup is lost too.** Keeping it
separately, off the VPS, is the owner's job — in a password manager, or on
paper. This script cannot do that, and does not try to.

### Which destination — recommendation

| | Cost | Setup | Comment |
|---|---|---|---|
| **Backblaze B2** | 10 GB free | API key, **no** browser OAuth | **Recommended** |
| Google Drive | 15 GB free | OAuth in a browser | Getting the token onto a headless server is a hassle (below) |
| A second VPS / NAS | The server's price | SSH key | Fully in your own hands, but one more machine to look after |

**Size is nothing to worry about** — 8 dumps = 12 MB; at most a few hundred MB
a year. Any free tier lasts many years.

**Wherever you keep it, keep `BACKUP_PASSPHRASE` separately, off the server**
(in a password manager). The files are encrypted with AES-256 — if the
passphrase is lost the backup is lost, whether it is in the cloud or on a home PC.

#### B2 — step by step *(~5 minutes of your time)*

1. An account at backblaze.com → **B2 Cloud Storage** → *Create a Bucket*
   → name `oxeio-backups`, **Private**.
2. *Application Keys* → **Add a New Application Key** → Read & Write on that
   bucket only. The `keyID` and `applicationKey` are **shown only once** —
   put them in the password manager straight away.
3. On the VPS:

```bash
rclone config
# n → name: b2 → storage: b2 → account: <keyID> → key: <applicationKey>
# hard_delete: false → q
rclone lsd b2:oxeio-backups        # no output means all is well
```

**No browser is needed** — that is what makes B2 simpler than Drive on a
headless server. The two keys are your own, so this step is yours; nobody
should send them in chat or email.

4. Then step 2 below — `RCLONE_REMOTE=b2:oxeio-backups`.

### Step 1 — install rclone and bind the remote *(one-off, ~10 minutes)*

```bash
curl https://rclone.org/install.sh | sudo bash
rclone config
```

`rclone config` is **interactive**, and for Google/Dropbox it needs a browser
login — this is the owner's own account, so the owner has to do it.

The steps: `n` (new remote) → name it `gdrive` → choose the storage (`drive`
for Google Drive) → **leave client id/secret blank** → scope `1`
(full access) → `y` for auto config → log in in the browser → `q`.

A headless server has no browser, so run `rclone authorize` on your own laptop
and paste the token — `rclone config` itself explains the steps.

To verify:

```bash
rclone lsd gdrive:
```

### Step 2 — try it

```bash
cd /opt/oxeio
RCLONE_REMOTE=gdrive:oxeio-backups bash oxeio-monitor/deploy/offsite-backup.sh
```

The script **stops** if rclone is missing, no remote is set, the remote cannot
be reached, or **the folder contains no dump at all**. The last one is checked
separately, because exiting with "success" on an empty folder is the best-known
silent failure of this project.

### Step 3 — make it weekly

```bash
cat >/etc/systemd/system/oxeio-offsite.service <<'EOF'
[Unit]
Description=oXeio — offsite backup (R5)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/oxeio-offsite.env
WorkingDirectory=/opt/oxeio
ExecStart=/usr/bin/env bash oxeio-monitor/deploy/offsite-backup.sh
EOF

cat >/etc/systemd/system/oxeio-offsite.timer <<'EOF'
[Unit]
Description=oXeio — offsite backup, weekly

[Timer]
OnCalendar=Sat 04:00
# Careful: this is UTC - the server's timezone is Etc/UTC, and the unit has no Timezone=.
#    So in Dhaka it is **Saturday 10 am**. Look at that time when searching.
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo 'RCLONE_REMOTE=gdrive:oxeio-backups' >/etc/oxeio-offsite.env

systemctl daemon-reload && systemctl enable --now oxeio-offsite.timer
systemctl list-timers oxeio-offsite.timer
```

The remote's name is in `/etc/oxeio-offsite.env`, not in the unit file — changing
it needs no `daemon-reload`, and anything secret does not end up in the unit file
(which anyone can read). The hyphen in `EnvironmentFile=-` is deliberate: the
service starts even if the file is missing, and then the script itself says
clearly what is missing.

**Status as last checked:** the timer is **installed and enabled** on the VPS
(next run Saturday 04:00). The script's whole path was verified in the field by
treating a local folder as the remote — 3 files went, pruning ran, and the news
reached Telegram. **Only `rclone config` remains** — it is a login to the
owner's own Google account, so the owner has to do it. Until then the timer
runs every Saturday and **fails cleanly** ("RCLONE_REMOTE is not set"), not silently.

`Persistent=true` — if the server is off at that time, the job runs after it
comes up. Otherwise one reboot would mean one week silently skipped.

Saturday 4 am: after the nightly dump (02:30) is done, and before office hours begin.

### What this script does **not** have yet

- **A restore drill.** Having uploaded does not mean it can be restored — the
  two are not the same, and this project itself learned that once in the field.
  The quarterly drill is still by hand (see § 10).
- **Screenshot files are not sent** — only the database dump. The images are in
  `.data/storage`, and they are deleted after 90 days anyway; sending them
  offsite would defeat that retention period.


## About the scripts

- **All three** `.ps1` files (`make-cert` · `defender-exclusions` ·
  `agent/installer/build`) are stored **with a UTF-8 BOM**. Do not remove the
  BOM — Windows PowerShell 5.1 treats a file without a BOM as ANSI, and then
  the Bengali text inside breaks and the script does not even parse.
  `build.ps1` **did not have the BOM from the first day**, and it went
  unnoticed because the previous MSI had been built with `pwsh` (PowerShell 7) —
  which assumes UTF-8 even without a BOM. When an MSI was built, the script
  stopped with three `Unexpected token` errors. So on a machine without
  PowerShell 7 (such as the office server PC) **the MSI could not be built at all**.
- Yet `certs\*.pem` is written **without a BOM** — the opposite rule. With a
  BOM, Node cannot read the PEM.
