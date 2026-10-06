#!/usr/bin/env bash
#
# oXeio - update the running stack on the VPS
#
# Run (as root on the VPS):
#     bash /opt/oxeio/oxeio-monitor/deploy/vps-update.sh
#
# What it does: git pull -> migration if needed -> rebuild -> health check.
# **Safe to run repeatedly.** With nothing new it does almost nothing.
#
# Careful: **the seed is not run - deliberately.** Compose's `migrate` service
#    is `migrate deploy && tsx prisma/seed.ts` - so calling it runs the seed too,
#    and the seed **upserts the staff's names, salaries and joining dates**.
#    Run during an update, it would overwrite data entered by hand in the
#    dashboard with the file's old values - silently, and straight into the
#    payroll figures. So only `migrate deploy` is called here, overriding the command.
#
# Careful: this script prints no secret values.

set -euo pipefail

DIR="${OXEIO_DIR:-/opt/oxeio}"

die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
say() { printf '\n\033[36m── %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m⚠️  %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "root হিসেবে চালান (sudo -i)"
[ -d "$DIR/.git" ]   || die "$DIR-এ রিপো নেই — প্রথমবার হলে vps-setup.sh চালান"

# Careful: the compose file is **not at the repo root**, it is inside `oxeio-monitor/`.
#    The same mistake once happened in vps-setup.sh (09 § ৩শ, trap 5).
COMPOSE_DIR="$DIR/oxeio-monitor"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || COMPOSE_DIR="$DIR"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "docker-compose.yml পাওয়া গেল না"

# ── 1. New code ─────────────────────────────────────────────────────────────
say "১· নতুন কোড আনা"

cd "$DIR"
BEFORE="$(git rev-parse HEAD)"

# Careful: on a private repo git **hangs** asking for a password, and the script
#    then sits stuck without any message (09 § ৩শ, trap 4). With this it does
#    not hang, it fails - and the reason can be stated.
GIT_TERMINAL_PROMPT=0 git pull --ff-only \
  || die "git pull ব্যর্থ — deploy key ঠিক আছে কি না দেখুন (ssh -T git@github.com)"

AFTER="$(git rev-parse HEAD)"

# A07: refuse to rebuild a checkout older than the last verified deployment.
# Direct deployments must write this marker only after source and health checks pass.
RELEASE_MARKER="$(git rev-parse --git-path oxeio-deployed-commit)"
if [ -f "$RELEASE_MARKER" ]; then
  DEPLOYED_COMMIT="$(cat "$RELEASE_MARKER")"
  git cat-file -e "$DEPLOYED_COMMIT^{commit}" 2>/dev/null \
    || die "Deployed source is missing locally. Synchronize it before rebuilding."
  git merge-base --is-ancestor "$DEPLOYED_COMMIT" HEAD \
    || die "This checkout is older than, or diverges from, the deployed release."
fi
git diff --quiet && git diff --cached --quiet \
  || die "Tracked source has local changes. Review and commit them before deployment."

if [ "$BEFORE" = "$AFTER" ]; then
  ok "নতুন কিছু নেই — কোড ইতিমধ্যেই সর্বশেষ"
else
  ok "$(git rev-list --count "$BEFORE..$AFTER")টি নতুন কমিট"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/     /'
fi

# ── 2. Migration ────────────────────────────────────────────────────────────
# ── Version ──────────────────────────────────────────────────────────────
# The version comes **from git**, not written by hand.
#
#    `rev-list --count` goes up by exactly **one** per commit - so the number
#    really does "rise with every change", and nobody can forget to bump it.
#    Careful: a hand-bumped number would one day lag behind, and then the screen
#    would say new code is running while the old one ran - a wrong version is
#    worse than no version.
#
# Careful: `export` - `docker compose` reads these in `build.args` (docker-compose.yml).
export APP_BUILD="$(git rev-list --count HEAD 2>/dev/null || echo dev)"
export APP_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
export APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ok "ভার্সন #$APP_BUILD · $APP_COMMIT"

say "২· ডাটাবেসের গড়ন"

cd "$COMPOSE_DIR"

# **The question is asked of the database, not of git.**
#
# Careful: the condition used to be "did `migrations/` change in this pull".
#    That went silently wrong twice, and both times the deploy **showed green**
#    and went ahead without the tables:
#
#      1. the pathspec was relative to the CWD, so the diff was always empty
#      2. someone had run `git pull` by hand **before** the script, so
#         BEFORE == AFTER - to the script nothing had changed, while a whole
#         migration was still pending in the database
#
# Both mistakes share one root: **git history does not know "what has been
#    applied to the database".** So the condition was dropped - now it asks
#    `migrate status` directly, and applies anything pending. One extra
#    container runs (a few seconds), and in exchange the trap is gone.
if docker compose --profile setup run --rm migrate      npx prisma migrate status >/dev/null 2>&1; then
  ok "নতুন migration নেই"
else
  warn "migration বাকি আছে — প্রয়োগ করা হচ্ছে"

  # Careful: **override** the command - otherwise compose's own command would
  #    run the seed too, and the staff's names/salaries/dates would be overwritten by the file's values.
  docker compose --profile setup run --rm migrate     npx prisma migrate deploy     || die "migration ব্যর্থ — স্ট্যাক পুরোনো কোডেই চলছে, ডেটা অক্ষত"

  # Careful: ask **again** after applying. "Was run" and "nothing pending" are
  #    not the same - if `migrate deploy` partly succeeds and returns 0, it
  #    will be caught right here, before the app breaks.
  docker compose --profile setup run --rm migrate     npx prisma migrate status >/dev/null 2>&1     || die "প্রয়োগের পরেও migration বাকি — অ্যাপ চালু করা হয়নি"

  ok "migration প্রয়োগ হয়েছে"
fi

# ── 3. Rebuild ──────────────────────────────────────────────────────────────
say "৩· ইমেজ তৈরি ও চালু"

# Careful: without `--build` the old image would keep running - the code arrives but does not run.
#    This is the easiest mistake to make: "I did pull, so why has nothing changed?"
docker compose up -d --build

# Careful: **prune the build cache - otherwise the disk fills up silently.**
#
# Measured in the field: after ~30 deploys in one day, buildkit's cache stood
# at **64 GB**, and the 83 GB disk was 86% full - while the real data was only
# 1.3 GB. Careful: when the disk fills, ingest stops and backups fail; so on the
# very day a backup is needed it would not be there.
#
# `--keep-storage` keeps the recent 5 GB, so the next build is not slow - only
#    the old layers go.
# Careful: `builder prune`, **not** `system prune` - the latter would also delete
#    images, and then no old image would be at hand for a rollback.
docker builder prune -f --keep-storage 5GB >/dev/null 2>&1 || true

ok "কনটেইনার চালু"

# ── 4. Is it really running ─────────────────────────────────────────────────
say "৪· স্বাস্থ্য পরীক্ষা"

# Careful: the API takes a few seconds to come up. Checking immediately would
#    call a healthy stack "broken", and someone might roll back over that false message.
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -fsS --max-time 3 http://127.0.0.1:3000/api/v1/health 2>/dev/null || true)"
  case "$HEALTH" in *'"status":"ok"'*) break ;; esac
  sleep 2
done

case "$HEALTH" in
  *'"status":"ok"'*)
    ok "API সাড়া দিচ্ছে — $HEALTH"
    ;;
  *)
    docker compose ps
    die "API ৪০ সেকেন্ডেও সাড়া দেয়নি। লগ দেখুন:  docker compose logs api --tail 60"
    ;;
esac

case "$HEALTH" in
  *"\"commit\":\"$APP_COMMIT\""*) ;;
  *) die "API is healthy but is not running the source commit just deployed." ;;
esac
git -C "$DIR" rev-parse HEAD > "$(git -C "$DIR" rev-parse --absolute-git-dir)/oxeio-deployed-commit"

printf '\n\033[32m✅ হালনাগাদ শেষ\033[0m — %s\n\n' "$(git -C "$DIR" rev-parse --short HEAD)"
