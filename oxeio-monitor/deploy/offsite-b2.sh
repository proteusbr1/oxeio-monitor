#!/usr/bin/env bash
#
# Bind a Backblaze B2 remote with a single command.
#
# Why this script: `rclone config` is interactive - n, name, storage number,
#    account, key, hard_delete, q ... six or seven steps, and one wrong key press
#    means starting over. Here it is all one line, and at the end it also checks
#    that the remote **really works**.
#
# Careful: **never pass the two keys as arguments** (`bash offsite-b2.sh KEYID KEY`) -
#    arguments are visible in `ps` and stay in bash history. The script asks for
#    them itself, and shows nothing on screen while you type.
#
# Careful: the keys never go to a log, echo or Telegram - there is no `set -x`
#    below, and the output of `rclone config create` is suppressed too.
#
# Run (as root on the VPS):
#     bash /opt/oxeio/oxeio-monitor/deploy/offsite-b2.sh
#
# Safe to run repeatedly - if the remote **already works** it only verifies and
#    moves on; if it does not, it asks for the two keys again.

set -euo pipefail

REMOTE_NAME="${B2_REMOTE_NAME:-b2}"
BUCKET="${B2_BUCKET:-oxeio-backups}"
ENV_FILE="${OFFSITE_ENV:-/etc/oxeio-offsite.env}"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
say()  { printf '   %s✓%s %s\n' "$c_ok" "$c_off" "$1"; }
warn() { printf '   %s⚠%s %s\n' "$c_warn" "$c_off" "$1"; }
die()  { printf '\n%s❌ %s%s\n\n' "$c_err" "$1" "$c_off" >&2; exit 1; }

printf '\n%s── R5 · Backblaze B2 রিমোট%s\n' "$c_dim" "$c_off"

[ "$(id -u)" -eq 0 ] || die "root হিসেবে চালান (sudo -i)"
command -v rclone >/dev/null 2>&1 || die \
  'rclone নেই। বসান: curl https://rclone.org/install.sh | sudo bash'

has_remote() { rclone listremotes 2>/dev/null | grep -qx "${REMOTE_NAME}:"; }

# Careful: **bucket first, then account** - the order matters. If a key is
#    restricted to a single bucket (as recommended), it **is not allowed to list
#    all buckets**. Testing only with `rclone lsd b2:` made even a perfect key
#    fail - exactly that happened once, and the mistake was in the test, not in
#    the key.
works() {
  rclone lsd "${REMOTE_NAME}:${BUCKET}" >/dev/null 2>&1 \
    || rclone lsd "${REMOTE_NAME}:" >/dev/null 2>&1
}

# ── 0. Does the existing remote really work ────────────────────────────────
#
# Careful: this used to check only whether a remote exists, and assumed it was
#    fine if so. Once a remote was bound with a wrong key it **could never be
#    changed again** - the script kept saying "already exists" and failing at the
#    same place every time. (Happened in the field.)
if has_remote && works; then
  say "রিমোট '${REMOTE_NAME}' আগে থেকেই আছে আর কাজ করছে"
elif has_remote; then
  warn "রিমোট '${REMOTE_NAME}' আছে, কিন্তু B2 তাকে মানছে না — কী দুটো আবার নেওয়া হবে"
  printf '   %sB2 যা বলল:%s\n' "$c_dim" "$c_off"
  rclone lsd "${REMOTE_NAME}:${BUCKET}" 2>&1 | tail -2 | sed 's/^/     /'
  rclone config delete "${REMOTE_NAME}" >/dev/null 2>&1 || true
fi

# ── 1. Bind anew if needed ─────────────────────────────────────────────────
if ! has_remote; then
  printf '\n   Backblaze-এর Application Key দুটো লাগবে।\n'
  printf '   %s(backblaze.com → B2 → Application Keys → Add a New Application Key)%s\n\n' "$c_dim" "$c_off"

  # Careful: `read -s` shows nothing on screen while typing, so nobody can read
  #    over a shoulder, and it does not show up in screen sharing.
  read -rp '   keyID          : ' B2_ID
  read -rsp '   applicationKey : ' B2_KEY; echo

  [ -n "${B2_ID}" ] && [ -n "${B2_KEY}" ] || die 'দুটোই লাগবে — কিছু বসানো হয়নি'

  # Note: **length only, never the key** - B2's keyID is 25 characters and the
  #    applicationKey 31.
  #    Careful: if a paste into a hidden prompt is partial (this happens in
  #    cmd.exe), nothing would show it, and the mistake would surface much later
  #    as a mysterious 401.
  printf '   %sপাওয়া গেল: keyID %d অক্ষর (আশা ২৫), applicationKey %d অক্ষর (আশা ৩১)%s\n' \
    "$c_dim" "${#B2_ID}" "${#B2_KEY}" "$c_off"
  [ "${#B2_ID}" -eq 25 ] || warn 'keyID-র দৈর্ঘ্য অস্বাভাবিক — পুরোটা কপি হয়েছে তো?'
  [ "${#B2_KEY}" -eq 31 ] || warn 'applicationKey-র দৈর্ঘ্য অস্বাভাবিক — পুরোটা কপি হয়েছে তো?'

  # Careful: output suppressed - on success rclone prints the whole config, key included.
  rclone config create "$REMOTE_NAME" b2 \
      account="$B2_ID" key="$B2_KEY" hard_delete=false >/dev/null 2>&1 \
    || die 'rclone config create ব্যর্থ'

  unset B2_ID B2_KEY
  say "রিমোট '${REMOTE_NAME}' বাঁধা হলো"
fi

# ── 2. Can it really be reached ────────────────────────────────────────────
#
# Careful: this step must not be skipped. `config create` **succeeds** even with
#    a wrong key - it only writes the file and does not verify. Stopping there
#    would look fine, and the mistake would surface on Saturday night, after
#    the timer fails.
if rclone lsd "${REMOTE_NAME}:${BUCKET}" >/dev/null 2>&1; then
  say "B2-তে পৌঁছানো যাচ্ছে (bucket '${BUCKET}')"
elif rclone lsd "${REMOTE_NAME}:" >/dev/null 2>&1; then
  say 'B2-তে পৌঁছানো যাচ্ছে (অ্যাকাউন্ট-স্তরে)'
else
  printf '   %sB2 যা বলল:%s\n' "$c_dim" "$c_off"
  rclone lsd "${REMOTE_NAME}:${BUCKET}" 2>&1 | tail -2 | sed 's/^/     /'
  die "B2 কী-জোড়া মানছে না। ⚠️ '401 bad_auth_token' সাধারণত মানে applicationKey ভুল বা অসম্পূর্ণ — ওটা একবারই দেখানো হয়, তাই হাতে না থাকলে নতুন key বানিয়ে আবার চালান"
fi

# ── 3. bucket ──────────────────────────────────────────────────────────────
if rclone lsd "${REMOTE_NAME}:${BUCKET}" >/dev/null 2>&1; then
  say "bucket '${BUCKET}' পাওয়া গেল"
else
  warn "bucket '${BUCKET}' নেই — বানানো হচ্ছে"
  rclone mkdir "${REMOTE_NAME}:${BUCKET}" \
    || die "bucket বানানো গেল না — key-টার কি ওই bucket-এ write আছে?"
  say "bucket '${BUCKET}' বানানো হলো"
fi

# ── 4. What the timer reads ────────────────────────────────────────────────
#
# Careful: `oxeio-offsite.service` has `EnvironmentFile=-/etc/oxeio-offsite.env`,
#    so RCLONE_REMOTE must be set here - not in the app's `.env`.
if grep -q '^RCLONE_REMOTE=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^RCLONE_REMOTE=.*|RCLONE_REMOTE=${REMOTE_NAME}:${BUCKET}|" "$ENV_FILE"
else
  printf 'RCLONE_REMOTE=%s:%s\n' "$REMOTE_NAME" "$BUCKET" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
say "${ENV_FILE}: RCLONE_REMOTE=${REMOTE_NAME}:${BUCKET}"

# ── 5. Do one upload right now ─────────────────────────────────────────────
#
# We do not wait for Saturday. "I configured it" and "the backup is really
#    offsite" are not the same thing, and the worst time to learn the
#    difference is the day the server is lost.
printf '\n%s── প্রথম আপলোড%s\n' "$c_dim" "$c_off"
set -a; . "$ENV_FILE"; set +a
bash "$(dirname "$0")/offsite-backup.sh"

printf '\n%s── রিমোটে যা আছে%s\n' "$c_dim" "$c_off"
rclone ls "${REMOTE_NAME}:${BUCKET}" | tail -20
printf '\n   মোট: %s\n' "$(rclone size "${REMOTE_NAME}:${BUCKET}" 2>/dev/null | tr '\n' ' ')"

printf '\n%s✅ B2 অফসাইট ব্যাকআপ চালু%s — শনিবার ০৪:০০-এ নিজে থেকেই যাবে\n\n' "$c_ok" "$c_off"
