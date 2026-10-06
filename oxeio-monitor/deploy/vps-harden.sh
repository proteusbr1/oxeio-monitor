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
#    this project once (port 22 closed, the only way back was the provider's
#    web console - deploy/README.md, "SSH times out").
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

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo -i)"
command -v apt-get >/dev/null 2>&1 || die "apt-get not found — this script is written for Debian/Ubuntu"

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
say "1· Packages"

need=()
for p in fail2ban unattended-upgrades; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done

if [ "${#need[@]}" -gt 0 ]; then
  apt-get update -qq >/dev/null 2>&1 \
    || warn "apt-get update failed — trying with the cached package lists"
  if ! apt-get install -y -qq "${need[@]}" >"$TMPDIR_OX/apt.log" 2>&1; then
    sed 's/^/     /' "$TMPDIR_OX/apt.log" >&2 || true
    die "could not install: ${need[*]} — see the messages above"
  fi
  ok "installed — ${need[*]}"
else
  ok "fail2ban and unattended-upgrades already installed"
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
say "2· Where sshd logs"

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
  warn "no auth.log and no python3-systemd — going on with the systemd backend"
  warn "if the jail does not come up in step 6, this is the reason"
fi

# ── 3. Jail ───────────────────────────────────────────────────────────────
say "3· SSH jail"

IGNOREIP="127.0.0.1/8 ::1"
# Careful: `if`, not `[ ... ] && ...` - with an empty IGNORE_EXTRA the `&&`
#    would return false, and under `set -e` that would stop the script.
if [ -n "$IGNORE_EXTRA" ]; then
  IGNOREIP="$IGNOREIP $IGNORE_EXTRA"
fi

mkdir -p "$(dirname "$JAIL_FILE")"

# Careful: keep every **value** in the file below pure ASCII. The jail file is
#    read by fail2ban through Python's configparser, without an explicit
#    encoding, so how non-ASCII text is read depends on the locale: under
#    latin-1 it would come out garbled - silently - and under ascii it fails.
#    Non-ASCII in a `#` comment line is harmless (a value line stays intact);
#    in a value (say in `action`) it could silently produce a wrong setting.

{
  cat <<EOF
# Written by deploy/vps-harden.sh - a change made here by hand is overwritten
#    the next time it runs. For a permanent change, change the script.

[DEFAULT]
# Bans are deliberately NOT permanent. With \`bantime = -1\` your own IP,
#    after a few mistyped passwords, would be locked out forever - and the
#    only way back would be the provider's web console, which you then have
#    to find at exactly the moment you have no time. One hour is enough to
#    stop brute force, and a bearable penalty for your own mistake.
bantime  = $BANTIME
findtime = 10m
maxretry = 5
ignoreip = $IGNOREIP

[sshd]
enabled  = true

# This one line is the main reason this file exists.
#    fail2ban's default sshd jail says \`port = ssh\`, and \`ssh\` is ONLY 22
#    according to /etc/services. sshd may also listen on 2222 (an alternative
#    port for networks whose ISP blocks 22). Left at the default the hardening
#    would be SILENTLY half done: brute force stopped on 22, unlimited tries on
#    2222 - while \`fail2ban-client status sshd\` happily showed "active".
#    False reassurance is worse than none.
port     = $SSH_PORTS

backend  = $F2B_BACKEND
EOF
  if [ -n "$F2B_LOGPATH" ]; then
    printf 'logpath  = %s\n' "$F2B_LOGPATH"
  fi
} > "$TMPDIR_OX/jail"

if install_if_changed "$TMPDIR_OX/jail" "$JAIL_FILE"; then
  CHANGED_JAIL=1
  ok "written → $JAIL_FILE  (ports $SSH_PORTS)"
else
  ok "unchanged → $JAIL_FILE  (ports $SSH_PORTS)"
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
say "4· Starting fail2ban"

# Check the config before the restart - with a bad config fail2ban **cannot
#    start**, and the jail that was running would be lost too. Checking first
#    means a bad config breaks nothing.
if f2b_test="$(fail2ban-client -t 2>&1)"; then
  ok "config test passed"
else
  case "$f2b_test" in
    *"no such option"*|*"Usage:"*|*"unrecognized"*)
      # Careful: this fail2ban has no `-t` - that is not "bad config", it is
      #    "could not verify". Conflating the two would stop the script even on a good config.
      warn "this version has no 'fail2ban-client -t' — the config could not be verified"
      ;;
    *)
      printf '%s\n' "$f2b_test" | sed 's/^/     /' >&2
      # Careful: the message must not overstate: the jail file has **already been
      #    written** ($JAIL_FILE). What has not happened is the restart - so the
      #    running fail2ban still has its old config, and sshd was not touched.
      die "fail2ban config error — see the messages above. Nothing was restarted: the running fail2ban and SSH are unchanged. Fix it and run again, or delete $JAIL_FILE."
      ;;
  esac
fi

systemctl enable fail2ban >/dev/null 2>&1 || true

if [ "$CHANGED_JAIL" -eq 1 ]; then
  systemctl restart fail2ban || true
  ok "jail changed — service restarted"
elif ! systemctl is-active --quiet fail2ban; then
  systemctl start fail2ban || true
  ok "service was not running — started"
else
  ok "service already running, config unchanged — not restarted"
fi

# ── 5. Automatic security updates ─────────────────────────────────────────
say "5· Automatic security updates"

cat > "$TMPDIR_OX/apt-periodic" <<'CONF'
// Written by deploy/vps-harden.sh.
// Having the config is not enough: unless the two values below are 1,
//    unattended-upgrades NEVER runs, even though it is installed.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF

cat > "$TMPDIR_OX/apt-uu" <<'CONF'
// Written by deploy/vps-harden.sh - a change made here by hand is overwritten next time.

// Do not remove `#clear`. apt config lists are APPENDED, not replaced - without
//    it the list below would be merged with the one in the distro's
//    50unattended-upgrades, and if someone enabled `-updates` there we would
//    unknowingly pull in ALL updates.
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;

// Security only - deliberately. This host keeps everyone's work hours; a
//    feature upgrade arriving by itself at 3 am and breaking something is a
//    worse risk than security patches going in quietly.
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// NEVER reboot by itself. A reboot stalls every agent's uploads for a few
//    minutes, and during working hours nobody would understand why
//    screenshots stop arriving. If a kernel update needs a reboot, do it at a
//    time you choose - `cat /var/run/reboot-required` tells you.
Unattended-Upgrade::Automatic-Reboot "false";

// Remove old kernels - otherwise /boot fills up, and then the NEXT updates
//    start failing, silently.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
CONF

if install_if_changed "$TMPDIR_OX/apt-periodic" "$APT_PERIODIC"; then
  ok "written → $APT_PERIODIC"
else
  ok "unchanged → $APT_PERIODIC"
fi

if install_if_changed "$TMPDIR_OX/apt-uu" "$APT_FILE"; then
  ok "written → $APT_FILE  (security only)"
else
  ok "unchanged → $APT_FILE  (security only)"
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
say '6· Verification — "was run" and "is running" are not the same'

FAIL=0

if systemctl is-active --quiet fail2ban; then
  ok "fail2ban service running"
else
  journalctl -u fail2ban -n 20 --no-pager 2>/dev/null | sed 's/^/     /' || true
  die "fail2ban is not running — see the log above (systemctl status fail2ban)"
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
  ok "sshd jail is up"
else
  printf '%s\n' "$jail_status" | sed 's/^/     /' >&2
  die "the sshd jail did not come up — see the messages above (journalctl -u fail2ban -n 40)"
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
  warn "could not read the port list from the live firewall rules — this does"
  warn "not mean the jail is not working, only that it could not be verified. Check by hand:"
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
    warn "guarded in the firewall: $rule_ports — but NOT:$missing"
    FAIL=1
  else
    ok "really guarded in the firewall: $rule_ports"
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
  warn "could not tell which ports sshd listens on (no ss?) — 'ss -ltnp | grep sshd'"
else
  ok "sshd listening on: $ssh_listen"
  uncovered=""
  for p in ${ssh_listen//,/ }; do
    found=0
    for q in ${SSH_PORTS//,/ }; do
      if [ "$p" = "$q" ]; then found=1; fi
    done
    if [ "$found" -eq 0 ]; then uncovered="$uncovered $p"; fi
  done
  if [ -n "$uncovered" ]; then
    warn "SSH ports outside the jail:$uncovered — brute force is not stopped there"
    warn "    add them:  OXEIO_SSH_PORTS=$SSH_PORTS$(printf '%s' "$uncovered" | tr ' ' ',') bash $0"
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
  1) ok "unattended-upgrade on (APT::Periodic::Unattended-Upgrade = 1)" ;;
  *) warn "APT::Periodic::Unattended-Upgrade = ${uu_val:-unknown}, expected 1 — updates will not run"
     FAIL=1 ;;
esac

origins="$(apt-config dump Unattended-Upgrade::Allowed-Origins 2>/dev/null || true)"
if [ -z "$origins" ]; then
  warn "could not read Allowed-Origins — check 'apt-config dump Unattended-Upgrade'"
else
  printf '%s\n' "$origins" | sed 's/^/     /'
  # Careful: if `-updates` or `-proposed` slip in, it is no longer "security only".
  if printf '%s' "$origins" | grep -qE '\-(updates|proposed|backports)'; then
    warn "a non-security origin got in — check 50unattended-upgrades"
    FAIL=1
  else
    ok "security origins only"
  fi
fi

# The timers - even with a perfect config, if the timer is off **nothing will ever run**.
for t in apt-daily.timer apt-daily-upgrade.timer; do
  if systemctl is-active --quiet "$t"; then
    ok "$t running"
  else
    warn "$t not running — updates will never run, however right the config"
    warn "    systemctl enable --now $t"
    FAIL=1
  fi
done

# ── 7. Result ─────────────────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[32m✅ Hardening done\033[0m\n\n'
else
  printf '\n\033[33m⚠️  Partial — read the warnings above\033[0m\n\n'
fi

echo "   Jail status     :  fail2ban-client status sshd"
echo "   Lift a ban      :  fail2ban-client set sshd unbanip <IP>"
echo "   Update dry run  :  unattended-upgrade --dry-run -v"
printf '\n'
printf '   \033[33m⚠️ 80/443 (Caddy) are outside this jail — Docker-published ports\033[0m\n'
printf '   \033[33m   are DNAT-ed through the FORWARD/DOCKER chain, not INPUT.\033[0m\n'
printf '   \033[32m   ✓ That side is handled in Caddy — login limited to 30/minute per IP\033[0m\n'
printf '   \033[32m     (rate_limit in web/Caddyfile). This jail is for SSH only.\033[0m\n\n'

# Careful: exit 0 even on FAIL - deliberate. What was installed stays installed,
#    and treating an incomplete verification as failure would make people afraid
#    to run the script again. What could not be determined is stated clearly
#    above - that is the real result.
#    Careful: the line is explicit: if the exit code came from the last
#    printf's result, adding one line in future would silently change it.
exit 0
