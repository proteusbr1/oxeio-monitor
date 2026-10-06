#!/usr/bin/env bash
#
# oXeio - first-time VPS setup
#
# Run (as root on the VPS):
#     bash /opt/oxeio/oxeio-monitor/deploy/vps-setup.sh monitor.example.com
#
# Careful: do not drop the `oxeio-monitor/` part of the path - this script is
#    not at the repo root, it is one level inside.
#
# What it does: Docker - firewall - code - DNS check - generating secrets -
#    starting the stack - printing the first-run setup link.
# **Safe to run repeatedly** - it does not touch what is already done, and once
#    `.env` exists it never touches it again (the secrets would change).
#
# There is no owner account yet when this finishes: the owner is created in the
#    web setup wizard, through the one-time link printed at the end.
#
# Careful: this script prints no secret values, except the setup link (its
#    token is only good until the wizard has been completed).
#
# Environment overrides:
#     OXEIO_REPO   git URL to clone   (default: the public GitHub repo)
#     OXEIO_DIR    where to clone it  (default: /opt/oxeio)

set -euo pipefail

PUBLIC_HOST="${1:-}"
REPO="${OXEIO_REPO:-https://github.com/proteusbr1/oxeio-monitor.git}"
DIR="${OXEIO_DIR:-/opt/oxeio}"

die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
say() { printf '\033[36m── %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m⚠️  %s\033[0m\n' "$*"; }

[ -n "$PUBLIC_HOST" ] || die "Give the domain:  bash deploy/vps-setup.sh monitor.example.com"
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo -i)"

# ── 1. Docker ────────────────────────────────────────────────────────────
say "1· Docker"
if command -v docker >/dev/null 2>&1; then
  ok "already installed — $(docker --version | cut -d, -f1)"
else
  curl -fsSL https://get.docker.com | sh
  ok "installed"
fi
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"

# ── 2. Firewall ──────────────────────────────────────────────────────────
say "2· Firewall"

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
  # 2222 - an alternative SSH port. Some ISPs silently block outbound port 22,
  #    and then the server runs fine but cannot be reached.
  #    Careful: opening it here does not **create** the door - sshd has to be told
  #    to listen there (deploy/README.md, "SSH times out"). It is opened ahead of
  #    time so ufw is no obstacle on the day it is needed.
  ufw allow 2222/tcp >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "22 · 2222 · 80 · 443 open"
  # Careful: 5432 and 3000 are deliberately closed - compose binds them to
  #    127.0.0.1, so there is no reason to reach them from outside.
else
  # Careful: it could not even be installed - this can no longer be allowed to pass quietly.
  warn "could not install ufw — open 22/2222/80/443 in your provider's firewall"
  warn "and close everything else, or the host stays completely unprotected"
fi

# **Verify** what was installed - "was run" and "is running" are not the same.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
  ok "firewall active"
else
  # Careful: a quote, not a backtick - a backtick inside double quotes runs a command.
  warn 'firewall NOT active — check with "ufw status verbose"'
fi

# ── 3. Code ──────────────────────────────────────────────────────────────
say "3· Code"

# Careful: `GIT_TERMINAL_PROMPT=0` - without it a wrong or private repo URL makes
#    git silently sit at `Username for 'https://github.com':`, which inside a
#    script looks as if something is stuck. Now it fails at once instead.
export GIT_TERMINAL_PROMPT=0

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || die "git pull failed — check the network and $DIR"
  ok "updated"
else
  git clone --depth 1 "$REPO" "$DIR" 2>&1 \
    || die "could not clone $REPO — check the URL and the network (a private fork needs OXEIO_REPO=git@github.com:<you>/<repo>.git and a deploy key)"
  ok "cloned → $DIR"
fi

# Careful: the compose files are **not at the repo root**, they are inside `oxeio-monitor/`.
#
#    This is where it got stuck once: the clone succeeded, but the script did
#    `cd` to the root and called `docker compose` - and there is no
#    docker-compose.yml there.
#
#    Both layouts work, so a change in the repo structure will not break it.
COMPOSE_DIR="$DIR/oxeio-monitor"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || COMPOSE_DIR="$DIR"
[ -f "$COMPOSE_DIR/docker-compose.yml" ]   || die "docker-compose.yml not found (looked inside $DIR)"

cd "$COMPOSE_DIR"
ok "compose folder → $COMPOSE_DIR"

# ── 4. DNS - **before bringing the stack up** ────────────────────────────
#
# Careful: this step is the most important, and the one most often skipped.
#
#    If the stack is brought up before DNS has propagated, Caddy asks Let's
#    Encrypt for a certificate, validation fails, and it keeps retrying.
#    Careful: LE also limits failed attempts (5 per hour) - past the limit the
#    domain is **locked out for an hour**, and even after fixing DNS you cannot
#    get a certificate right away.
say "4· DNS check"
resolved="$(getent hosts "$PUBLIC_HOST" 2>/dev/null | awk '{print $1}' | head -1 || true)"
myip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"

[ -n "$resolved" ] || die "$PUBLIC_HOST does not resolve yet. DNS can take a while to propagate (up to the record's TTL). Run this again a little later."
ok "$PUBLIC_HOST → $resolved"

if [ -n "$myip" ] && [ "$resolved" != "$myip" ]; then
  die "DNS points to $resolved, but this server's IP is $myip — fix the A record."
fi
[ -n "$myip" ] && ok "matches this server's IP"

# ── 5. .env ──────────────────────────────────────────────────────────────
say "5· .env"
if [ -f .env ]; then
  ok ".env already exists — left untouched"
else
  cp .env.example .env

  # Secrets are generated right here - there is no chance to type them by hand,
  #    so no way for a weak password or a stale copy-pasted value to get in.
  gen() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
  PG_PW="$(gen 48 32)"
  JWT="$(gen 64 48)"
  SHOT="$(gen 48 32)"
  BACKUP="$(gen 48 32)"
  SETUP="$(gen 48 32)"

  set_env() {
    # Careful: `|` as the delimiter - base64 can contain `/`, which would break `sed s/.../.../`
    if grep -qE "^$1=" .env; then
      sed -i "s|^$1=.*|$1=$2|" .env
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  set_env POSTGRES_PASSWORD "$PG_PW"
  set_env JWT_SECRET "$JWT"
  set_env SCREENSHOT_URL_SECRET "$SHOT"
  set_env BACKUP_PASSPHRASE "$BACKUP"
  # The token of the first-run setup link. Chosen here (instead of the random
  #    one the api would print in its log) so this script can print the link.
  set_env SETUP_TOKEN "$SETUP"
  set_env CORS_ORIGIN "https://$PUBLIC_HOST"

  # Careful: the password must be set again in DATABASE_URL - otherwise the sample
  #    password from .env.example would remain there.
  pg_user="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"
  pg_db="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"
  set_env DATABASE_URL "postgresql://$pg_user:$PG_PW@postgres:5432/$pg_db?schema=public"

  {
    echo ""
    echo "# ── VPS (written by vps-setup.sh) ──"
    echo "PUBLIC_HOST=$PUBLIC_HOST"
    echo "COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml"
  } >> .env

  chmod 600 .env
  ok "created — every secret freshly generated"
  warn "BACKUP_PASSPHRASE is in .env — keep a copy OFF this server (password manager)."
  warn "Without it no backup can ever be decrypted."
fi

# The host folders for screenshots and backups, owned by the api's user.
#
# Careful: if docker creates a missing bind-mount folder itself, it is owned by
#    root, while the api runs as `node` (uid 1000) - every write then fails with
#    EACCES: screenshot rows without files, a nightly backup that never lands.
#    The image's own `chown` does not help: the host folder's ownership wins.
env_val() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
storage_dir="$(env_val STORAGE_HOST_PATH)"
backup_dir="$(env_val BACKUP_HOST_PATH)"
# the same defaults as docker-compose.yml
for d in "${storage_dir:-./.data/storage}" "${backup_dir:-./.data/backups}"; do
  mkdir -p "$d"
  chown 1000:1000 "$d"
done
ok "storage and backup folders ready (owner uid 1000)"

# ── 6. Stack ─────────────────────────────────────────────────────────────
# `up -d` builds the images on the first run, brings the database schema up to
#    date (the `migrate` service, which the api waits for), then starts the api
#    and the web. No separate migration or seed step is needed.
say "6· Starting the stack (the first build takes a few minutes)"
docker compose up -d \
  || die "the stack did not start — see:  docker compose logs migrate api --tail 60"

# Careful: the API takes a few seconds to answer. Checking only once would call
#    a healthy stack "broken".
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --max-time 3 http://127.0.0.1:3000/api/v1/health 2>/dev/null || true)"
  case "$HEALTH" in *'"status":"ok"'*) break ;; esac
  sleep 2
done
case "$HEALTH" in
  *'"status":"ok"'*) ok "API is answering" ;;
  *) docker compose ps
     die "the API did not answer within 60 seconds. Logs:  docker compose logs api --tail 60" ;;
esac
ok "Caddy now fetches the certificate from Let's Encrypt"

# ── 7. Result ────────────────────────────────────────────────────────────
printf '\n\033[32m✅ Done\033[0m\n\n'
echo "   Dashboard : https://$PUBLIC_HOST"

# Whether the wizard is still needed - asked of the API, not guessed: on a
#    re-run after the setup was completed there is nothing to open.
setup_status="$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/setup/status 2>/dev/null || true)"
setup_token="$(grep -E '^SETUP_TOKEN=' .env | cut -d= -f2- || true)"

case "$setup_status" in
  *'"needed":false'*)
    echo "   Setup     : already completed — sign in with the owner account."
    ;;
  *)
    if [ -n "$setup_token" ]; then
      printf '\n   \033[33mFirst run — open this link to create the owner account:\033[0m\n'
      echo "      https://$PUBLIC_HOST/setup?token=$setup_token"
    else
      # Careful: an older `.env` (made before SETUP_TOKEN existed) has no token,
      #    so the api made a random one and printed it in its log.
      printf '\n   \033[33mFirst run — the setup link is in the api log:\033[0m\n'
      echo "      docker compose logs api | grep setup"
    fi
    echo "   (The wizard asks for the company, time zone, currency, the owner"
    echo "    account and the work week. The link stops working once it is done.)"
    ;;
esac

printf '\n   Certificate progress :  docker compose logs -f web\n'
printf '   Status               :  docker compose ps\n'
printf '   Next                 :  bash %s/deploy/vps-harden.sh\n\n' "$COMPOSE_DIR"
printf '   \033[33m⚠️ The certificate takes 10–60 seconds. Until then the browser shows an error.\033[0m\n\n'
