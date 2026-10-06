#!/usr/bin/env bash
#
# Upload the nightly backups **offsite**.
#
# What it does: copies the new dumps from `.data/backups` to a remote with
#    `rclone`, prunes old copies, and reports the result on Telegram.
#
# Careful: **why this is needed, and why the nightly backup alone is not enough:**
#    the nightly dump exists and is encrypted, but **all on one machine**. If
#    that disk dies or the VPS is lost, the backup goes with it - having a
#    backup and being able to **use** a backup are not the same.
#
# **The files are already encrypted** (`BACKUP_PASSPHRASE`, openssl enc).
#    So wherever you upload them (Drive/S3), the provider can read nothing of
#    the staff's hours, salaries or screenshots - this does not conflict with a
#    "data must not leave the country" policy.
#    Careful: but it also means **if the passphrase is lost, the backup is lost
#    too**. Keeping it separately, off the VPS, is the owner's job, outside this script.
#
# Careful: **safe to run repeatedly** - `rclone copy` only uploads missing files.
#
# Run:    bash deploy/offsite-backup.sh
# Setup:  deploy/README.md, "Offsite copy"
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/oxeio/oxeio-monitor}"
BACKUP_DIR="${BACKUP_HOST_DIR:-$COMPOSE_DIR/.data/backups}"
REMOTE="${RCLONE_REMOTE:-}"
KEEP_WEEKS="${OFFSITE_KEEP_WEEKS:-8}"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
say()  { printf '   %s✓%s %s\n' "$c_ok" "$c_off" "$1"; }
warn() { printf '   %s⚠%s %s\n' "$c_warn" "$c_off" "$1"; }
die()  { printf '\n%s❌ %s%s\n' "$c_err" "$1" "$c_off" >&2; notify "❌ Offsite backup failed — $1"; exit 1; }

# ── Telegram ─────────────────────────────────────────────────────────────────
#
# Careful: the token and chat id are read from the app's own `.env` - writing
#    them in a second place would one day leave one changed and the other
#    stale, and the failure report itself would be lost.
# Careful: with no config the script does **not stop**, it just stays quiet:
#    being unable to send the news is no reason to skip the backup.
notify() {
  local text="$1" token chat
  [[ -f "$COMPOSE_DIR/.env" ]] || return 0
  token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$COMPOSE_DIR/.env" | cut -d= -f2- || true)
  chat=$(grep -E '^TELEGRAM_CHAT_ID=' "$COMPOSE_DIR/.env" | cut -d= -f2- || true)
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -fsS -m 20 -X POST \
    "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat}" --data-urlencode "text=${text}" >/dev/null 2>&1 || true
}

printf '\n%s── Offsite backup%s\n' "$c_dim" "$c_off"

# ── 0. Config set on screen ───────────────────────────────────────────────
#
# The B2 key now lives **in the database** (Settings -> Storage & backup), so there is no
#    need to SSH into the VPS and run `rclone config`. Careful: the old path
#    still works: if `RCLONE_REMOTE` is already set, the database is not touched.
#
# No config file is written - rclone itself reads `RCLONE_CONFIG_<NAME>_<FIELD>`
#    variables. Careful: so the key never lands on disk, it exists only in
#    this process's environment.
if [[ -z "${REMOTE}" ]] && command -v docker >/dev/null 2>&1; then
  # Careful: the database name/user are not in the host's environment - they are
  #    in compose's `.env`, just like the Telegram token (`notify()` does the same).
  pg_user=$(grep -E '^POSTGRES_USER=' "$COMPOSE_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  pg_db=$(grep -E '^POSTGRES_DB=' "$COMPOSE_DIR/.env" 2>/dev/null | cut -d= -f2- || true)

  cfg=$(cd "$COMPOSE_DIR" 2>/dev/null && docker compose exec -T postgres psql -U "${pg_user:-oxeio}" -d "${pg_db:-oxeio}" -tAc "SELECT concat_ws('|', value->>'keyId', value->>'appKey', value->>'bucket') FROM settings WHERE key = 'ops.offsite'" 2>/dev/null | tr -d '[:space:]' || true)

  IFS='|' read -r db_id db_key db_bucket <<< "${cfg:-}"

  if [[ -n "${db_id:-}" && -n "${db_key:-}" && -n "${db_bucket:-}" ]]; then
    export RCLONE_CONFIG_B2_TYPE=b2
    export RCLONE_CONFIG_B2_ACCOUNT="$db_id"
    export RCLONE_CONFIG_B2_KEY="$db_key"
    export RCLONE_CONFIG_B2_HARD_DELETE=false
    REMOTE="b2:${db_bucket}"
    unset db_id db_key db_bucket cfg
    say 'config from the screen (Settings → Storage & backup)'
  fi
fi

# ── 1. What it cannot run without ─────────────────────────────────────────────
command -v rclone >/dev/null 2>&1 || die \
  'rclone is missing. Install it: curl https://rclone.org/install.sh | sudo bash'

[[ -n "$REMOTE" ]] || die \
  'no offsite destination set — enter the B2 key in the dashboard under Settings → Storage & backup (or set RCLONE_REMOTE)'

[[ -d "$BACKUP_DIR" ]] || die "backup folder not found: $BACKUP_DIR"

# Careful: **the folder existing and the folder containing dumps are two
#    different things.** Exiting with "success" on an empty folder would make the
#    script look green every day while nothing went offsite. This is the best-known
#    silent failure in this project.
count=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump.enc' -type f | wc -l)
[[ "$count" -gt 0 ]] || die \
  "not a single dump in $BACKUP_DIR — is the nightly backup running (BACKUP_PASSPHRASE set)?"
say "$count dump(s) found"

# ── 2. Can the remote really be reached ────────────────────────────────────────
#
# Careful: verify first, because `rclone copy` can look **successful** even
#    against a wrong remote (it creates a new folder). "Reached" and "reached the right place" differ.
rclone lsd "$REMOTE" >/dev/null 2>&1 || rclone mkdir "$REMOTE" >/dev/null 2>&1 || die \
  "cannot reach the remote: $REMOTE (check it with rclone config)"
say "remote reachable — $REMOTE"

# ── 3. Upload ──────────────────────────────────────────────────────────────────
#
# `copy`, **not** `sync` - this is the most important decision here.
# Careful: `sync` makes the remote an exact mirror of the source, so **if the
#    server's disk were wiped, the next run would delete the offsite copy too** -
#    at the very moment it is the only copy left. Pruning is done separately
#    below, by age.
before=$(rclone size "$REMOTE" --json 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2 || echo 0)

rclone copy "$BACKUP_DIR" "$REMOTE" \
  --include '*.dump.enc' --include '*.sha256' --include 'README-restore.txt' \
  --transfers 2 --retries 3 --stats-one-line --stats 30s \
  || die 'rclone copy failed'

after=$(rclone size "$REMOTE" --json 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2 || echo 0)
say "files on the remote: $before → $after"

# ── 4. Prune old copies ────────────────────────────────────────────────────────
#
# Careful: pruning is **by the remote's age**, not by comparing with the local
#    folder - the `sync` trap above would come back here.
age_days=$(( KEEP_WEEKS * 7 ))
rclone delete "$REMOTE" --min-age "${age_days}d" --include '*.dump.enc*' 2>/dev/null || true
say "copies older than $KEEP_WEEKS weeks pruned"

# ── 5. Report ─────────────────────────────────────────────────────────────────
newest=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump.enc' -type f -printf '%f\n' \
  | sort | tail -1)
size=$(du -sh "$BACKUP_DIR" | cut -f1)

notify "$(printf 'oXeio — offsite backup ok\n%s\nRemote: %s (%s files)\nLocal: %s' \
  "$newest" "$REMOTE" "$after" "$size")"

printf '\n%s✅ Offsite backup done%s — %s\n\n' "$c_ok" "$c_off" "$newest"
