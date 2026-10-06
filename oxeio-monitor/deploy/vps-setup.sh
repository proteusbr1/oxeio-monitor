#!/usr/bin/env bash
#
# oXeio - first-time VPS setup (ADR-026)
#
# Run (as root on the VPS):
#     bash /opt/oxeio/oxeio-monitor/deploy/vps-setup.sh hub.oxeio.com
#
# Careful: do not drop the `oxeio-monitor/` part of the path - this script is
#    not at the repo root, it is one level inside.
#
# What it does: Docker - firewall - generating secrets - DNS check - starting the stack.
# **Safe to run repeatedly** - it does not touch what is already done, and once
#    `.env` exists it never touches it again (the secrets would change).
#
# Careful: this script prints no secret values, except one: the owner password
#    generated on the first run - it is shown only once.

set -euo pipefail

PUBLIC_HOST="${1:-}"
REPO="${OXEIO_REPO:-https://github.com/ownCoder/oxeio-monitor.git}"
DIR="${OXEIO_DIR:-/opt/oxeio}"

die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
say() { printf '\033[36m── %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m⚠️  %s\033[0m\n' "$*"; }

[ -n "$PUBLIC_HOST" ] || die "ডোমেইন দিন:  bash deploy/vps-setup.sh hub.oxeio.com"
[ "$(id -u)" -eq 0 ] || die "root হিসেবে চালান (sudo -i)"

# ── 1. Docker ────────────────────────────────────────────────────────────
say "১· Docker"
if command -v docker >/dev/null 2>&1; then
  ok "আগে থেকেই আছে — $(docker --version | cut -d, -f1)"
else
  curl -fsSL https://get.docker.com | sh
  ok "বসানো হলো"
fi
docker compose version >/dev/null 2>&1 || die "docker compose প্লাগইন নেই"

# ── 2. Firewall ──────────────────────────────────────────────────────────
say "২· ফায়ারওয়াল"

# Careful: this used to say: if ufw is missing, just print a warning.
#    A port scan from outside showed the VPS had **no firewall running at all** -
#    3306, 8080, 9999 all answered with an immediate RST, whereas with ufw
#    active they would have been silently DROPped.
#    So this very `else` branch had run, and the warning got lost in the log
#    noise. Nobody reads a warn; the script's job is to **do**, not to tell.
if ! command -v ufw >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq ufw >/dev/null 2>&1 || true
fi

if command -v ufw >/dev/null 2>&1; then
  # Careful: SSH first - the other way round, your own connection is cut the
  #    moment `ufw enable` runs, and then there is no way into the VPS (except the console).
  ufw allow 22/tcp  >/dev/null
  # 2222 - the alternative SSH door. Many ISPs (e.g. AmberIT, Bangladesh) silently
  #    block outbound port 22, and then the server runs fine but cannot be reached.
  #    Careful: opening it here does not **create** the door - sshd has to be told
  #    to listen there (deploy/README § 12.4c). It is opened ahead of time so ufw
  #    is no obstacle on the day it is needed, because that day there is no time.
  ufw allow 2222/tcp >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "২২ · ২২২২ · ৮০ · ৪৪৩ খোলা"
  # Careful: 5432 and 3000 are deliberately closed - compose binds them to
  #    127.0.0.1, so there is no reason to reach them from outside.
else
  # Careful: it could not even be installed - this can no longer be allowed to pass quietly.
  warn "ufw বসানো গেল না — প্রোভাইডারের ফায়ারওয়ালে ২২/২২২২/৮০/৪৪৩ খুলে"
  warn "বাকি সব বন্ধ করুন, নইলে হোস্ট সম্পূর্ণ অরক্ষিত থাকবে"
fi

# **Verify** what was installed - "was run" and "is running" are not the same.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
  ok "ফায়ারওয়াল সক্রিয়"
else
  # Careful: a quote, not a backtick - a backtick inside double quotes runs a command.
  warn '⚠️ ফায়ারওয়াল সক্রিয় নয় — "ufw status verbose" দিয়ে দেখুন'
fi

# ── 3. Code ──────────────────────────────────────────────────────────────
say "৩· কোড"

# Careful: `GIT_TERMINAL_PROMPT=0` - without it **the script hangs**.
#
#    The repo is private, so cloning over HTTPS makes git silently sit at
#    `Username for 'https://github.com':` - and inside a script that looks
#    odd, as if something is stuck.
#    This is exactly what happened on the owner's first attempt.
#
#    Now it fails immediately instead of hanging, and what to do is printed below.
export GIT_TERMINAL_PROMPT=0

clone_help() {
  cat <<EOF

রিপোটা **private**, তাই বেনামে clone করা যায় না। deploy key বসান —
শুধু-পড়ার অনুমতি, শুধু এই রিপোর জন্য:

  ১· চাবি বানান ও দেখুন:
       ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "oxeio-vps" <<< y
       ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
       cat ~/.ssh/id_ed25519.pub

  ২· GitHub → রিপো → Settings → Deploy keys → Add deploy key
     (⚠️ "Allow write access" টিক দেবেন না)

  ৩· তারপর SSH ঠিকানা দিয়ে আবার:
       OXEIO_REPO=git@github.com:ownCoder/oxeio-monitor.git \
         bash $DIR/oxeio-monitor/deploy/vps-setup.sh $PUBLIC_HOST
EOF
}

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || die "pull ব্যর্থ — নেট বা অনুমতি দেখুন"
  ok "হালনাগাদ"
else
  if ! git clone --depth 1 "$REPO" "$DIR" 2>&1; then
    clone_help
    die "clone করা গেল না ($REPO)"
  fi
  ok "ক্লোন হলো → $DIR"
fi

# Careful: the compose files are **not at the repo root**, they are inside `oxeio-monitor/`.
#
#    This is where it got stuck once: the clone succeeded, but the script did
#    `cd` to the root and called `docker compose` - and there is no
#    docker-compose.yml there. (The run command also had the wrong path.)
#
#    Both layouts work, so a change in the repo structure will not break it.
COMPOSE_DIR="$DIR/oxeio-monitor"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || COMPOSE_DIR="$DIR"
[ -f "$COMPOSE_DIR/docker-compose.yml" ]   || die "docker-compose.yml পাওয়া গেল না ($DIR-এর ভেতরে খোঁজা হয়েছে)"

cd "$COMPOSE_DIR"
ok "compose ফোল্ডার → $COMPOSE_DIR"

# ── 4. DNS - **before bringing the stack up** ────────────────────────────
#
# Careful: this step is the most important, and the one most often skipped.
#
#    If the stack is brought up before DNS has propagated, Caddy asks Let's
#    Encrypt for a certificate, validation fails, and it keeps retrying.
#    Careful: LE also limits failed attempts (5 per hour) - past the limit the
#    domain is **locked out for an hour**, and even after fixing DNS you cannot
#    get a certificate right away.
say "৪· DNS যাচাই"
resolved="$(getent hosts "$PUBLIC_HOST" 2>/dev/null | awk '{print $1}' | head -1 || true)"
myip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"

[ -n "$resolved" ] || die "$PUBLIC_HOST কোথাও দেখাচ্ছে না। DNS ছড়াতে সময় লাগে (TTL ৭২০০ = ২ ঘণ্টা পর্যন্ত)। একটু পরে আবার চালান।"
ok "$PUBLIC_HOST → $resolved"

if [ -n "$myip" ] && [ "$resolved" != "$myip" ]; then
  die "DNS দেখাচ্ছে $resolved, কিন্তু এই সার্ভারের IP $myip — A রেকর্ডটা মিলিয়ে নিন।"
fi
[ -n "$myip" ] && ok "এই সার্ভারের IP-র সাথে মিলেছে"

# ── 5. .env ──────────────────────────────────────────────────────────────
say "৫· .env"
OWNER_PW=""
if [ -f .env ]; then
  ok ".env আগে থেকেই আছে — ছোঁয়া হয়নি"
else
  cp .env.example .env

  # Secrets are generated right here - there is no chance to type them by hand,
  #    so no way for a weak password or a stale copy-pasted value to get in.
  gen() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
  PG_PW="$(gen 48 32)"
  JWT="$(gen 64 48)"
  SHOT="$(gen 48 32)"
  BACKUP="$(gen 48 32)"
  OWNER_PW="$(gen 24 16)"

  set_env() {
    # Careful: `|` as the delimiter - base64 can contain `/`, which would break `sed s/.../.../`
    sed -i "s|^$1=.*|$1=$2|" .env
  }
  set_env POSTGRES_PASSWORD "$PG_PW"
  set_env JWT_SECRET "$JWT"
  set_env SCREENSHOT_URL_SECRET "$SHOT"
  set_env BACKUP_PASSPHRASE "$BACKUP"
  set_env SEED_OWNER_PASSWORD "$OWNER_PW"
  set_env CORS_ORIGIN "https://$PUBLIC_HOST"

  # Careful: the password must be set again in DATABASE_URL - otherwise the sample
  #    password from .env.example would remain and the api could not log in to the database.
  pg_user="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"
  pg_db="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"
  set_env DATABASE_URL "postgresql://$pg_user:$PG_PW@postgres:5432/$pg_db?schema=public"

  {
    echo ""
    echo "# ── VPS (vps-setup.sh বসিয়েছে) ──"
    echo "PUBLIC_HOST=$PUBLIC_HOST"
    echo "COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml"
  } >> .env

  chmod 600 .env
  ok "তৈরি — সব গোপন মান নতুন করে বানানো"
fi

# ── 6. Stack ─────────────────────────────────────────────────────────────
say "৬· স্কিমা ও seed"
docker compose --profile setup run --rm migrate
ok "মাইগ্রেশন ও seed হয়ে গেছে"

say "৭· স্ট্যাক তোলা"
docker compose up -d
ok "উঠছে — Caddy এখন Let's Encrypt থেকে সার্ট নেবে"

# ── 8. Result ────────────────────────────────────────────────────────────
printf '\n\033[32m✅ হয়ে গেছে\033[0m\n\n'
echo "   ড্যাশবোর্ড : https://$PUBLIC_HOST"
owner_email="$(grep -E '^SEED_OWNER_EMAIL=' .env | cut -d= -f2-)"
if [ -n "$OWNER_PW" ]; then
  printf '
   [33m⚠️  owner লগইন — এটা একবারই দেখানো হচ্ছে:[0m
'
  echo "      $owner_email"
  echo "      $OWNER_PW"
  echo "   (প্রথম লগইনেই বদলাতে বলবে — সেটা ঠিক আচরণ)"
else
  # Careful: if `.env` already existed, no new password is generated, so there
  #    is nothing to print - and the owner then gets a **running system** with no
  #    known way to log in. This is exactly what happened once: an earlier attempt
  #    had created .env, the next attempt succeeded, but did not print the login.
  #
  #    The password is deliberately **not** printed here - it would stay in logs,
  #    screenshots or terminal scrollback. Instead it says where to find it.
  printf '
   [33mowner লগইন: %s[0m
' "$owner_email"
  echo "   পাসওয়ার্ড দেখতে:"
  echo "      grep '^SEED_OWNER_PASSWORD=' $COMPOSE_DIR/.env"
fi
printf '\n   সার্ট এলো কি না দেখতে:  docker compose logs -f web\n'
printf '   অবস্থা দেখতে        :  docker compose ps\n\n'
printf '   \033[33m⚠️ সার্ট আসতে ১০–৬০ সেকেন্ড লাগে। তার আগে ব্রাউজারে ভুল দেখাবে।\033[0m\n\n'
