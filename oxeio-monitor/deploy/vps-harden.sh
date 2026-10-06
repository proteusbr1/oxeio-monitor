#!/usr/bin/env bash
#
# oXeio - VPS hardening
#
# Run (as root on the VPS):
#     bash /opt/oxeio/oxeio-monitor/deploy/vps-harden.sh
#
# Careful: do not drop the `oxeio-monitor/` part of the path - this script is
#    not at the repo root, it is one level inside.
#
# What it does: fail2ban (SSH - 22 **and 2222**) - security-only automatic
#    updates - and at the end a check that they are **really running**.
# **Safe to run repeatedly** - it writes the same files with the same content,
#    and does not restart the service when nothing changed (the jail is empty
#    at the moment of a restart).
#
# Careful: this script **does not touch** sshd - it does not change the port,
#    does not disable password login, does not delete firewall rules. Deliberate:
#    locking your own door in the name of "hardening" has nearly happened in
#    this project once (README § 12.4 - port 22 closed, the only way back was
#    the web console).
#
# Careful: this script prints no secret values.

set -euo pipefail

# The ports are a variable - if sshd's door changes, pass them without editing the script:
#     OXEIO_SSH_PORTS=22,2222,2022 bash deploy/vps-harden.sh
SSH_PORTS="${OXEIO_SSH_PORTS:-22,2222}"

# Put your own static IP here and it will never be banned.
#    Careful: pointless with a dynamic IP - tomorrow it belongs to someone else.
IGNORE_EXTRA="${OXEIO_IGNOREIP:-}"

# Careful: 1 hour, not forever - the reason is written in the jail file below.
BANTIME="${OXEIO_BANTIME:-1h}"

# Why `jail.d/*.local` and not `/etc/fail2ban/jail.local` directly:
#    fail2ban reads files in this order - jail.conf -> jail.d/*.conf ->
#    jail.local -> **jail.d/*.local**. So this file has the last word and
#    overrides the distro defaults or anyone's hand-written jail.local -
#    while we delete none of those files.
JAIL_FILE=/etc/fail2ban/jail.d/oxeio-sshd.local

# Careful: number 52 - read **after** the distro's `50unattended-upgrades`, so
#    our values win. The distro file is left alone, otherwise the next package
#    upgrade would make dpkg ask "conffile has changed" - and a question in the
#    middle of an automatic upgrade means it hangs forever.
APT_FILE=/etc/apt/apt.conf.d/52oxeio-unattended-upgrades
APT_PERIODIC=/etc/apt/apt.conf.d/20auto-upgrades

die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
say() { printf '\n\033[36m── %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m⚠️  %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "root হিসেবে চালান (sudo -i)"
command -v apt-get >/dev/null 2>&1 || die "apt-get নেই — এই স্ক্রিপ্টটা Debian/Ubuntu-র জন্য লেখা"

# Careful: without this apt **hangs** midway asking "which version to keep?",
#    and inside a script that question is not even visible.
#    (The same mistake once happened with git in vps-setup.sh.)
export DEBIAN_FRONTEND=noninteractive

TMPDIR_OX="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_OX"' EXIT

# Check **first** whether the file changed, then write - this is what makes "safe
#    to run repeatedly" true. Otherwise the mtime would change every time, the
#    service would restart every time, and the jail would be empty for a few
#    seconds at each restart.
CHANGED_JAIL=0
install_if_changed() {  # $1 = temp file with the new content, $2 = destination
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    return 1
  fi
  install -m 0644 "$1" "$2"
  return 0
}

# ── 1. Packages ───────────────────────────────────────────────────────────
say "১· প্যাকেজ"

need=()
for p in fail2ban unattended-upgrades; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done

if [ "${#need[@]}" -gt 0 ]; then
  apt-get update -qq >/dev/null 2>&1 \
    || warn "apt-get update ব্যর্থ — ক্যাশে থাকা তালিকা দিয়ে চেষ্টা চলছে"
  if ! apt-get install -y -qq "${need[@]}" >"$TMPDIR_OX/apt.log" 2>&1; then
    sed 's/^/     /' "$TMPDIR_OX/apt.log" >&2 || true
    die "বসানো গেল না: ${need[*]} — উপরের বার্তা দেখুন"
  fi
  ok "বসানো হলো — ${need[*]}"
else
  ok "fail2ban ও unattended-upgrades আগে থেকেই আছে"
fi

# Careful: fail2ban's systemd backend does not work without Python's `systemd`
#    module, and that is only a Recommends - a host installed with
#    `--no-install-recommends` lacks it. Without it the jail **never starts**
#    even though the package is installed. So try to install it first, then
#    below choose the backend by checking whether it is really there.
if ! python3 -c 'import systemd.journal' >/dev/null 2>&1; then
  apt-get install -y -qq python3-systemd >/dev/null 2>&1 || true
fi

# ── 2. Where the log is - choosing the backend ────────────────────────────
say "২· sshd-র লগ কোথায়"

# Careful: skipping this step would make the jail look "enabled" while it
#    **reads nothing**. There are two realities, and which one holds varies by host:
#      - rsyslog present -> sshd's failed logins are written to /var/log/auth.log
#      - rsyslog absent  -> the log is only in journald (the default on Debian 12+)
#    journald is always there, so it is the first choice - but only when Python's
#    systemd module is really present, otherwise the jail will not come up.
F2B_LOGPATH=""
if python3 -c 'import systemd.journal' >/dev/null 2>&1; then
  F2B_BACKEND="systemd"
  ok "journald (backend = systemd)"
elif [ -s /var/log/auth.log ]; then
  F2B_BACKEND="auto"
  F2B_LOGPATH="/var/log/auth.log"
  ok "/var/log/auth.log (backend = auto)"
else
  # Careful: neither could be confirmed. This is not "no log", it is "don't know" -
  #    so we go on assuming systemd, and the check in § 6 will tell the truth.
  F2B_BACKEND="systemd"
  warn "auth.log নেই, python3-systemd-ও পাওয়া গেল না — systemd ধরে এগোনো হচ্ছে"
  warn "§ ৬-এর যাচাইয়ে জেল না দাঁড়ালে এখানেই কারণ"
fi

# ── 3. Jail ───────────────────────────────────────────────────────────────
say "৩· SSH জেল"

IGNOREIP="127.0.0.1/8 ::1"
# Careful: `if`, not `[ ... ] && ...` - with an empty IGNORE_EXTRA the `&&`
#    would return false, and under `set -e` that would stop the script.
if [ -n "$IGNORE_EXTRA" ]; then
  IGNOREIP="$IGNOREIP $IGNORE_EXTRA"
fi

mkdir -p "$(dirname "$JAIL_FILE")"

# Careful: in the file below, Bengali appears only on `#` comment lines - **never
#    in a value**. This rule is mandatory, because the jail file is read by
#    fail2ban, through Python's configparser, and without an explicit encoding
#    that depends on the locale. Three cases were checked by hand:
#      - utf-8   -> reads fine
#      - latin-1 -> the Bengali characters come out garbled, yet `port`/`backend`
#                   still come through - their lines are pure ASCII
#      - ascii   -> UnicodeDecodeError, i.e. it fails **loudly**
#    So there is no path to a "silently wrong config", and a loud failure is
#    caught by `fail2ban-client -t` in § 4 **before** the restart.
#    Careful: but if Bengali ever enters a value (not a comment, say in
#    `action`), the latin-1 case would silently produce a wrong value - so don't.

{
  cat <<EOF
# ⚠️ এই ফাইলটা deploy/vps-harden.sh লেখে — হাতে বদলালে পরের বার চালানোয়
#    বদলটা মুছে যাবে। স্থায়ী বদল দরকার হলে স্ক্রিপ্টটাই বদলান।

[DEFAULT]
# ⚠️⚠️ ব্যান **স্থায়ী নয়**, ইচ্ছাকৃতভাবে। \`bantime = -1\` লিখলে নিজের
#    ভুল টাইপ করা IP-ও চিরকালের জন্য আটকে যেত — আর তখন ফেরার একমাত্র পথ
#    প্রোভাইডারের ওয়েব কনসোল, যেটা ঠিক সেই মুহূর্তেই খুঁজতে হয় যখন হাতে
#    সময় নেই (README § ১২.৪খ)। এক ঘণ্টা ব্রুট-ফোর্স থামানোর জন্য যথেষ্ট,
#    আর নিজের ভুলের শাস্তি হিসেবে সহনীয়।
bantime  = $BANTIME
findtime = 10m
maxretry = 5
ignoreip = $IGNOREIP

[sshd]
enabled  = true

# ⚠️⚠️ **এই একটা লাইনই এই ফাইলের মূল কারণ।**
#    fail2ban-এর ডিফল্ট sshd জেলে লেখা থাকে \`port = ssh\`, আর \`ssh\`
#    /etc/services অনুযায়ী **কেবল ২২**। এই সার্ভারে sshd ২২২২-এও শোনে
#    (README § ১২.৪গ — ISP ২২ আটকায় বলে বিকল্প দরজা)। ডিফল্টে ছেড়ে দিলে
#    হার্ডেনিংটা **নীরবে অর্ধেক** হতো: ২২-এ ব্রুট-ফোর্স থামত, আর ২২২২-এ
#    যত খুশি চেষ্টা চলত — অথচ \`fail2ban-client status sshd\` দিব্যি
#    "সক্রিয়" দেখাত। ভুল আশ্বাস কোনো আশ্বাস না থাকার চেয়ে খারাপ।
port     = $SSH_PORTS

backend  = $F2B_BACKEND
EOF
  if [ -n "$F2B_LOGPATH" ]; then
    printf 'logpath  = %s\n' "$F2B_LOGPATH"
  fi
} > "$TMPDIR_OX/jail"

if install_if_changed "$TMPDIR_OX/jail" "$JAIL_FILE"; then
  CHANGED_JAIL=1
  ok "লেখা হলো → $JAIL_FILE  (পোর্ট $SSH_PORTS)"
else
  ok "আগের মতোই আছে → $JAIL_FILE  (পোর্ট $SSH_PORTS)"
fi

# ── 3a. What Docker keeps out of this jail's reach ───────────────────────
#
#    fail2ban places bans in iptables' **INPUT** chain (ufw works there too).
#    Packets for sshd running on the host go through INPUT - so the SSH jail
#    really works, and § 6a checks it against the live rules.
#
#    Careful: but on Docker's **published ports** (here 80 and 443 - Caddy)
#    packets are DNAT-ed to the container, i.e. they go through the
#    **FORWARD/DOCKER** chain, not INPUT. So fail2ban's ban (even `ufw deny`)
#    never sees the packet there - this is the known "Docker bypasses ufw"
#    problem, and its effect is **silent**: the jail shows "active", the ban
#    count grows, yet the attacker keeps getting in.
#
#    So this script deliberately installs **only the SSH jail**, and does not
#    claim what it cannot do. The login route's rate limit therefore has to go
#    at the web layer - in Caddy; that is the other half of the VPS hardening.
#    (It could be stopped with rules in the DOCKER-USER chain, but then the
#    responsibility for bans would be split across two places - a separate
#    decision, a separate ADR.)

# ── 4. Start ──────────────────────────────────────────────────────────────
say "৪· fail2ban চালু"

# Check the config before the restart - with a bad config fail2ban **cannot
#    start**, and the jail that was running would be lost too. Checking first
#    means a bad config breaks nothing.
if f2b_test="$(fail2ban-client -t 2>&1)"; then
  ok "কনফিগ পরীক্ষা পাশ"
else
  case "$f2b_test" in
    *"no such option"*|*"Usage:"*|*"unrecognized"*)
      # Careful: this fail2ban has no `-t` - that is not "bad config", it is
      #    "could not verify". Conflating the two would stop the script even on a good config.
      warn "এই সংস্করণে 'fail2ban-client -t' নেই — কনফিগ যাচাই করা গেল না"
      ;;
    *)
      printf '%s\n' "$f2b_test" | sed 's/^/     /' >&2
      # Careful: the message must not overstate: the jail file has **already been
      #    written** ($JAIL_FILE). What has not happened is the restart - so the
      #    running fail2ban still has its old config, and sshd was not touched.
      die "fail2ban কনফিগে ভুল — উপরের বার্তা দেখুন। restart করা হয়নি, চলতি fail2ban ও SSH অপরিবর্তিত। ঠিক করে আবার চালান, বা $JAIL_FILE মুছে দিন।"
      ;;
  esac
fi

systemctl enable fail2ban >/dev/null 2>&1 || true

if [ "$CHANGED_JAIL" -eq 1 ]; then
  systemctl restart fail2ban || true
  ok "জেল বদলেছে — সার্ভিস restart করা হলো"
elif ! systemctl is-active --quiet fail2ban; then
  systemctl start fail2ban || true
  ok "সার্ভিস চলছিল না — চালু করা হলো"
else
  ok "সার্ভিস আগে থেকেই চলছে, কনফিগও অপরিবর্তিত — restart করা হয়নি"
fi

# ── 5. Automatic security updates ─────────────────────────────────────────
say "৫· স্বয়ংক্রিয় নিরাপত্তা আপডেট"

cat > "$TMPDIR_OX/apt-periodic" <<'CONF'
// ⚠️ এই ফাইলটা deploy/vps-harden.sh লেখে।
// ⭐ কেবল কনফিগ থাকলেই চলে না — নিচের দুটো মান ১ না হলে
//    unattended-upgrades বসানো থাকা সত্ত্বেও **কখনো চলে না**।
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF

cat > "$TMPDIR_OX/apt-uu" <<'CONF'
// ⚠️ এই ফাইলটা deploy/vps-harden.sh লেখে — হাতে বদলালে পরের বার মুছে যাবে।

// ⚠️⚠️ `#clear` বাদ দেওয়া যাবে না। apt-এর কনফিগে তালিকা **যোগ হয়**,
//    প্রতিস্থাপিত হয় না — অর্থাৎ এটা ছাড়া নিচের তালিকাটা ডিস্ট্রোর
//    50unattended-upgrades-এর তালিকার সাথে জুড়ে বসত, আর কেউ সেখানে
//    `-updates` চালু করে রাখলে আমরা অজান্তেই **সব** আপডেট টেনে আনতাম।
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;

// ⭐ শুধু security — ইচ্ছাকৃতভাবে। এই হোস্টে ১৫ জনের কাজের হিসাব চলে;
//    রাত ৩টায় নিজে থেকে একটা ফিচার-আপগ্রেড এসে কিছু ভাঙার চেয়ে
//    নিরাপত্তা-প্যাচগুলো নীরবে বসে যাওয়াই বেশি দরকারি।
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// ⚠️⚠️ রিবুট **কখনো নিজে থেকে নয়**। সার্ভার রিবুট মানে এজেন্টদের সব
//    আপলোড কয়েক মিনিট আটকে থাকা, আর সেটা যদি অফিস-সময়ে হয় তবে কেউ
//    বুঝতেই পারবে না কেন ছবি আসছে না। কার্নেল আপডেটের পর রিবুট
//    দরকার হলে সেটা মালিক বেছে নেওয়া সময়ে করবেন —
//    `cat /var/run/reboot-required` দেখলেই জানা যায়।
Unattended-Upgrade::Automatic-Reboot "false";

// ⭐ পুরোনো কার্নেল ছাঁটাই — নইলে /boot ভরে যায়, আর তখন **পরের
//    আপডেটগুলোই ব্যর্থ হতে থাকে**, নীরবে।
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
CONF

if install_if_changed "$TMPDIR_OX/apt-periodic" "$APT_PERIODIC"; then
  ok "লেখা হলো → $APT_PERIODIC"
else
  ok "আগের মতোই আছে → $APT_PERIODIC"
fi

if install_if_changed "$TMPDIR_OX/apt-uu" "$APT_FILE"; then
  ok "লেখা হলো → $APT_FILE  (শুধু security)"
else
  ok "আগের মতোই আছে → $APT_FILE  (শুধু security)"
fi

# Careful: Docker itself is outside this list - docker-ce comes from Docker's own
#    repo, which is not in Allowed-Origins. So the container engine running the
#    stack will not change overnight by itself. Deliberate.
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# ── 6. Verification ──────────────────────────────────────────────────────
#
# "Was run" and "is running" are not the same - this lesson is already written
#    in vps-setup.sh for the firewall (the script printed a warning, nobody read
#    it, and no firewall was running on the VPS). So below it is the
#    **live state** that is read, not the config files.
say '৬· যাচাই — "চালানো হয়েছে" আর "চালু আছে" এক নয়'

FAIL=0

if systemctl is-active --quiet fail2ban; then
  ok "fail2ban সার্ভিস চলছে"
else
  journalctl -u fail2ban -n 20 --no-pager 2>/dev/null | sed 's/^/     /' || true
  die "fail2ban চলছে না — উপরের লগ দেখুন (systemctl status fail2ban)"
fi

# Careful: after a restart it takes a few seconds for fail2ban's socket to
#    appear. Calling `fail2ban-client` immediately gives "Failed to access socket
#    path", and we would call even a **healthy** jail "not up" - and someone
#    would go digging in the config over that false message. The API health
#    check in vps-update.sh has exactly this wait, for the same reason.
for _ in $(seq 1 15); do
  if fail2ban-client ping >/dev/null 2>&1; then break; fi
  sleep 1
done

# Whether the jail really came up - the service running and the jail standing
#    are different things. With a wrong backend the service runs fine, only the jail is missing.
if jail_status="$(fail2ban-client status sshd 2>&1)"; then
  printf '%s\n' "$jail_status" | sed 's/^/     /'
  ok "sshd জেল দাঁড়িয়েছে"
else
  printf '%s\n' "$jail_status" | sed 's/^/     /' >&2
  die "sshd জেল দাঁড়ায়নি — উপরের বার্তা দেখুন (journalctl -u fail2ban -n 40)"
fi

# ── 6a. Are the ports really guarded ──────────────────────────────────────
#
# Careful: this is the script's most important check. `port = 22,2222` being
#    written in the config is not the same as both ports really being guarded in
#    the firewall - and if the second is not true, the failure is completely silent.
# Careful: **two backends, two completely different names and formats** - and
#    the first real run (Ubuntu 24.04) showed this was not being caught here:
#
#      iptables  -> chain name `f2b-sshd`,   ports `--dports 22,2222`
#      nftables  -> chain name `f2b-chain`,  set `addr-set-sshd`,
#                   ports `tcp dport { 22, 2222 }`
#
#    Modern Ubuntu's fail2ban picks **nftables** by default, so searching only
#    for `f2b-sshd` found nothing and the script stopped with "could not
#    verify" - while the jail was working fine (six IPs had even been banned).
rule_ports=""

if command -v iptables >/dev/null 2>&1; then
  f2b_rule="$(iptables -S INPUT 2>/dev/null | grep -F 'f2b-sshd' | head -1 || true)"
  if [ -n "$f2b_rule" ]; then
    rule_ports="$(printf '%s\n' "$f2b_rule" | sed -n 's/.*--dports \([0-9,]*\).*/\1/p' | head -1)"
  fi
fi

# Careful: search by `addr-set-sshd`, not `f2b-chain` - the chain is one for all
#    jails, but the set is jail-specific. So even with other jails present this
#    picks up exactly the sshd row.
if [ -z "$rule_ports" ] && command -v nft >/dev/null 2>&1; then
  f2b_rule="$(nft list ruleset 2>/dev/null | grep -F 'addr-set-sshd' | grep -F 'dport' | head -1 || true)"
  if [ -n "$f2b_rule" ]; then
    # `tcp dport { 22, 2222 } ...` -> `22,2222`  (dropping the whitespace)
    rule_ports="$(printf '%s\n' "$f2b_rule" \
      | sed -n 's/.*dport[[:space:]]*{\([^}]*\)}.*/\1/p' \
      | tr -d '[:space:]' | head -1)"
    # Careful: with a single port nft writes it without braces - `tcp dport 2222`
    if [ -z "$rule_ports" ]; then
      rule_ports="$(printf '%s\n' "$f2b_rule" \
        | sed -n 's/.*dport[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' | head -1)"
    fi
  fi
fi

if [ -z "$rule_ports" ]; then
  # Careful: "could not verify" - not "not working". Showing the two as one is
  #    forbidden in this project; a missing observation is not a failure.
  warn "চলতি ফায়ারওয়াল নিয়মে পোর্টের তালিকা পড়া গেল না — এর মানে জেল কাজ"
  warn "করছে না তা নয়, মানে যাচাই করা গেল না। হাতে দেখুন:"
  warn "    iptables -S INPUT | grep f2b-sshd"
else
  missing=""
  for p in ${SSH_PORTS//,/ }; do
    found=0
    for q in ${rule_ports//,/ }; do
      if [ "$p" = "$q" ]; then found=1; fi
    done
    if [ "$found" -eq 0 ]; then missing="$missing $p"; fi
  done
  if [ -n "$missing" ]; then
    warn "ফায়ারওয়ালে পাহারায় আছে: $rule_ports — কিন্তু নেই:$missing"
    FAIL=1
  else
    ok "ফায়ারওয়ালে সত্যিই পাহারায়: $rule_ports"
  fi
fi

# ── 6b. Which ports sshd is actually listening on ─────────────────────────
#
# We decide what is written in the jail; we do not decide where sshd listens.
#    If the two do not match, a door stays unguarded - so they are compared.
ssh_listen=""
if command -v ss >/dev/null 2>&1; then
  ssh_listen="$(ss -H -ltnp 2>/dev/null | awk '/sshd/ { n = split($4, a, ":"); print a[n] }' \
                | sort -un | paste -sd, - || true)"
fi

if [ -z "$ssh_listen" ]; then
  # Careful: again: not known != nothing there.
  warn "sshd কোন পোর্টে শুনছে জানা গেল না (ss পাওয়া যায়নি?) — 'ss -ltnp | grep sshd'"
else
  ok "sshd শুনছে: $ssh_listen"
  uncovered=""
  for p in ${ssh_listen//,/ }; do
    found=0
    for q in ${SSH_PORTS//,/ }; do
      if [ "$p" = "$q" ]; then found=1; fi
    done
    if [ "$found" -eq 0 ]; then uncovered="$uncovered $p"; fi
  done
  if [ -n "$uncovered" ]; then
    warn "জেলের বাইরে থাকা SSH পোর্ট:$uncovered — ওখানে ব্রুট-ফোর্স আটকাবে না"
    warn "    যোগ করুন:  OXEIO_SSH_PORTS=$SSH_PORTS$(printf '%s' "$uncovered" | tr ' ' ',') bash $0"
    FAIL=1
  fi
  # Careful: the opposite direction is not a failure: 2222 in the jail while
  #    sshd does not yet listen there is harmless, rather being ready ahead of
  #    time (like opening 2222 in ufw in advance in vps-setup.sh).
fi

# ── 6c. Are automatic updates really on ───────────────────────────────────
uu_on="$(apt-config dump APT::Periodic::Unattended-Upgrade 2>/dev/null | head -1 || true)"
# Only the value - in the whole line the key itself appears twice ('X = X "0";'),
#    and reading it you could not tell what was wanted and what was found.
uu_val="$(printf '%s' "$uu_on" | sed -n 's/.*"\([^"]*\)".*/\1/p')"
case "$uu_val" in
  1) ok "unattended-upgrade চালু (APT::Periodic::Unattended-Upgrade = 1)" ;;
  *) warn "APT::Periodic::Unattended-Upgrade = ${uu_val:-জানা যায়নি}, চাই 1 — আপডেট চলবে না"
     FAIL=1 ;;
esac

origins="$(apt-config dump Unattended-Upgrade::Allowed-Origins 2>/dev/null || true)"
if [ -z "$origins" ]; then
  warn "Allowed-Origins পড়া গেল না — 'apt-config dump Unattended-Upgrade' দেখুন"
else
  printf '%s\n' "$origins" | sed 's/^/     /'
  # Careful: if `-updates` or `-proposed` slip in, it is no longer "security only".
  if printf '%s' "$origins" | grep -qE '\-(updates|proposed|backports)'; then
    warn "security-র বাইরের origin ঢুকেছে — 50unattended-upgrades দেখুন"
    FAIL=1
  else
    ok "শুধু security origin"
  fi
fi

# The timers - even with a perfect config, if the timer is off **nothing will ever run**.
for t in apt-daily.timer apt-daily-upgrade.timer; do
  if systemctl is-active --quiet "$t"; then
    ok "$t চলছে"
  else
    warn "$t চলছে না — কনফিগ ঠিক থাকলেও আপডেট কখনো চলবে না"
    warn "    systemctl enable --now $t"
    FAIL=1
  fi
done

# ── 7. Result ─────────────────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[32m✅ শক্ত করা হয়ে গেছে\033[0m\n\n'
else
  printf '\n\033[33m⚠️  আংশিক — উপরের সতর্কবার্তাগুলো পড়ুন\033[0m\n\n'
fi

echo "   জেলের অবস্থা   :  fail2ban-client status sshd"
echo "   ব্যান তোলা      :  fail2ban-client set sshd unbanip <IP>"
echo "   আপডেট মহড়া     :  unattended-upgrade --dry-run -v"
printf '\n'
printf '   \033[33m⚠️ ৮০/৪৪৩ (Caddy) এই জেলের বাইরে — Docker-এর প্রকাশিত পোর্ট\033[0m\n'
printf '   \033[33m   DNAT হয়ে FORWARD/DOCKER চেইন দিয়ে যায়, INPUT দিয়ে নয়।\033[0m\n'
printf '   \033[32m   ✓ ওই দিকটা Caddy-তেই সামলানো — লগইনে ৩০/মিনিট প্রতি IP\033[0m\n'
printf '   \033[32m     (web/Caddyfile-এর rate_limit · G116)। এই জেল শুধু SSH-এর।\033[0m\n\n'

# Careful: exit 0 even on FAIL - deliberate. What was installed stays installed,
#    and treating an incomplete verification as failure would make people afraid
#    to run the script again. What could not be determined is stated clearly
#    above - that is the real result.
#    Careful: the line is explicit: if the exit code came from the last
#    printf's result, adding one line in future would silently change it.
exit 0
