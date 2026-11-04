#!/usr/bin/env bash
# install.sh: put Vidverse on a fresh Ubuntu 24.04 server. Run as root, from the unpacked project folder.
#
#   sudo ./deploy/install.sh ~/vidverse-setup.conf    first install (copy deploy/setup.conf.example and fill it in)
#   sudo ./deploy/install.sh                          update: install the code in this folder, keep every setting
#
# What it does, in order: checks the server and your settings (and stops before changing anything if something is
# wrong) -> installs PostgreSQL, ffmpeg, Caddy and Node.js 22 -> creates an unprivileged "vidverse" user and a database
# -> installs the code under /opt/vidverse -> writes /etc/vidverse/vidverse.env with fresh secrets -> installs the
# website, the video worker and a nightly backup as systemd services -> sets up Caddy for HTTPS (with a shared password
# in front of the site while it is a closed beta) -> starts everything and checks that it answers.
#
# It is safe to run again. It never overwrites /etc/vidverse/vidverse.env, never touches the database contents, takes a
# backup before an update, and installs new code beside the old (/opt/vidverse/releases/<time>) before switching.
# It does not change the firewall, except to open ports 80 and 443 if "ufw" is already switched on.
#
# Tested on Ubuntu 24.04 (see docs/TESTING.md for exactly what was and was not exercised). Read docs/DEPLOYMENT.md.
set -euo pipefail

APP_USER=vidverse
APP_DIR=/opt/vidverse
DATA_DIR=/var/lib/vidverse
ETC_DIR=/etc/vidverse
ENV_FILE=$ETC_DIR/vidverse.env
CADDYFILE=/etc/caddy/Caddyfile
GATE_FILE=/etc/caddy/vidverse-gate.caddy
NODE_MIN=22.12
# Where Node.js comes from when the server has no suitable one, and where it is put. All three can be overridden to
# test against a local copy; the defaults are the official Node.js 22 release folder, /opt and /usr/local/bin.
NODE_DIST_BASE=${NODE_DIST_BASE:-https://nodejs.org/download/release/latest-v22.x}
NODE_INSTALL_ROOT=${NODE_INSTALL_ROOT:-/opt}
BIN_LINK_DIR=${BIN_LINK_DIR:-/usr/local/bin}
OS_RELEASE=${OS_RELEASE:-/etc/os-release}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/.." && pwd)

SETTING_KEYS=(DOMAIN OPERATOR_NAME OPERATOR_ADDRESS CONTACT_EMAIL GRIEVANCE_OFFICER_NAME GRIEVANCE_OFFICER_EMAIL
  SMTP_URL MAIL_FROM LEGAL_JURISDICTION SITE_NAME BETA_GATE BETA_PASSWORD ACME_EMAIL ANTHROPIC_API_KEY
  TRANSCODE_PROFILE MAX_VIDEO_SECONDS MAX_UPLOAD_BYTES CREATOR_STORAGE_QUOTA_BYTES DAILY_UPLOAD_LIMIT SKIP_DNS_CHECK)
REQUIRED_KEYS=(DOMAIN OPERATOR_NAME OPERATOR_ADDRESS CONTACT_EMAIL GRIEVANCE_OFFICER_NAME GRIEVANCE_OFFICER_EMAIL SMTP_URL MAIL_FROM)
declare -A S=()
NODE_BIN=""
PORT=3000

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\nWARNING: %s\n' "$*" >&2; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------------------------------- settings

# Quote a value so the site's own settings reader (Node's env-file parser) reads back exactly what was written.
# Plain values stay plain; anything with spaces or symbols that the parser treats specially is quoted.
env_quote() {
  local v=$1
  if [[ $v =~ ^[A-Za-z0-9_./:@+,%=-]*$ ]]; then printf '%s' "$v"
  elif [[ $v != *\'* ]]; then printf "'%s'" "$v"
  elif [[ $v != *\"* && $v != *\\* ]]; then printf '"%s"' "$v"
  elif [[ $v != *\`* ]]; then printf '%s' "\`$v\`"
  else return 1
  fi
}

# Reads KEY=value lines (see deploy/setup.conf.example) into the S array. Nothing in the file is ever executed.
read_settings() {
  local file=$1 line key val n=0 k ok
  [ -r "$file" ] || die "cannot read the settings file: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$file, line $n: expected KEY=value but found: $line"
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    ok=no
    for k in "${SETTING_KEYS[@]}"; do [ "$k" = "$key" ] && ok=yes; done
    [ "$ok" = yes ] || die "$file, line $n: unknown setting $key. Check the spelling against deploy/setup.conf.example."
    val=${val#"${val%%[![:space:]]*}"}
    val=${val%"${val##*[![:space:]]}"}
    if [[ ${#val} -ge 2 && ( $val == \"*\" || $val == \'*\' ) ]]; then val=${val:1:${#val}-2}; fi
    S[$key]=$val
  done < "$file"
}

apply_defaults() {
  : "${S[LEGAL_JURISDICTION]:=India}"
  : "${S[SITE_NAME]:=Vidverse}"
  : "${S[BETA_GATE]:=on}"
  : "${S[ACME_EMAIL]:=${S[CONTACT_EMAIL]:-}}"
  : "${S[TRANSCODE_PROFILE]:=standard}"
  : "${S[MAX_VIDEO_SECONDS]:=1800}"
  : "${S[MAX_UPLOAD_BYTES]:=1073741824}"
  : "${S[CREATOR_STORAGE_QUOTA_BYTES]:=5368709120}"
  : "${S[DAILY_UPLOAD_LIMIT]:=5}"
  : "${S[SKIP_DNS_CHECK]:=no}"
  : "${S[ANTHROPIC_API_KEY]:=}"
  : "${S[BETA_PASSWORD]:=}"
}

validate_settings() {
  local k v missing=()
  for k in "${REQUIRED_KEYS[@]}"; do [ -n "${S[$k]:-}" ] || missing+=("$k"); done
  [ ${#missing[@]} -eq 0 ] || die "these settings are required but empty: ${missing[*]}"

  # Values copied from the example file and never edited would end up on the public legal pages.
  for k in "${REQUIRED_KEYS[@]}" ACME_EMAIL; do
    v=${S[$k]:-}
    if [[ $v =~ (^|[^a-zA-Z0-9-])example\.(com|org)([^a-zA-Z0-9-]|$) || $v == *"Your Name"* || $v == *"Street, City"* ]]; then
      die "$k still has the example value ($v). Put your own value in the settings file."
    fi
  done

  [[ ${S[DOMAIN]} =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "DOMAIN must look like videos.mysite.in: lower case, no https://, no slash (you wrote: ${S[DOMAIN]})."
  for k in CONTACT_EMAIL GRIEVANCE_OFFICER_EMAIL ACME_EMAIL; do
    [[ ${S[$k]} =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "$k is not an email address: ${S[$k]}"
  done
  [[ ${S[SMTP_URL]} =~ ^smtps?://[^[:space:]]+$ ]] || die "SMTP_URL must start with smtp:// or smtps:// and have no spaces (see deploy/setup.conf.example)."
  case "${S[BETA_GATE]}" in on|off) ;; *) die "BETA_GATE must be on or off." ;; esac
  case "${S[TRANSCODE_PROFILE]}" in standard|fast) ;; *) die "TRANSCODE_PROFILE must be standard or fast." ;; esac
  case "${S[SKIP_DNS_CHECK]}" in yes|no) ;; *) die "SKIP_DNS_CHECK must be yes or no." ;; esac
  for k in MAX_VIDEO_SECONDS MAX_UPLOAD_BYTES CREATOR_STORAGE_QUOTA_BYTES DAILY_UPLOAD_LIMIT; do
    [[ ${S[$k]} =~ ^[1-9][0-9]*$ ]] || die "$k must be a whole number greater than zero (you wrote: ${S[$k]})."
  done
  if [ -n "${S[BETA_PASSWORD]}" ] && [ "${#S[BETA_PASSWORD]}" -lt 8 ]; then die "BETA_PASSWORD must have at least 8 characters."; fi
  for k in "${SETTING_KEYS[@]}"; do
    env_quote "${S[$k]:-}" > /dev/null || die "$k contains ' \" and \` together, which cannot be stored. Remove some of the quote characters."
  done
}

# ---------------------------------------------------------------------------------------------------- checks

need_root() { [ "$(id -u)" -eq 0 ] || die "run this as root:  sudo ./deploy/install.sh ..."; }

check_os() {
  [ -r "$OS_RELEASE" ] || die "cannot tell which system this is ($OS_RELEASE is missing)."
  local id version
  # shellcheck disable=SC1090
  read -r id version < <(. "$OS_RELEASE"; echo "${ID:-?} ${VERSION_ID:-?}")
  if [ "$id" != ubuntu ] || [ "$version" != 24.04 ]; then
    if [ "${ALLOW_OTHER_OS:-no}" = yes ]; then
      warn "this is $id $version, not Ubuntu 24.04. Continuing because ALLOW_OTHER_OS=yes; package names and versions may differ."
    else
      die "this installer is tested on Ubuntu 24.04 LTS only (this is $id $version). Create a new server with Ubuntu 24.04, or read docs/DEPLOYMENT.md for the manual steps."
    fi
  fi
  case "$(uname -m)" in x86_64 | aarch64) ;; *) die "unsupported processor type $(uname -m) (x86_64 and aarch64 are supported)." ;; esac
}

check_resources() {
  local mem_kb free_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -lt 700000 ]; then
    die "this server has under 1 GB of memory. Use 2 GB at the very least; 4 GB is comfortable for video processing."
  elif [ "$mem_kb" -lt 1700000 ]; then
    warn "this server has about $((mem_kb / 1024)) MB of memory. The site will run, but processing longer videos may run out of memory. Set TRANSCODE_PROFILE=fast, or use a 2 GB server."
  fi
  free_kb=$(df -Pk /var | awk 'NR==2 {print $4}')
  if [ "$free_kb" -lt 3000000 ]; then
    die "less than 3 GB of free disk space under /var. Videos need room: use a server with at least 40 GB."
  elif [ "$free_kb" -lt 10000000 ]; then
    warn "under 10 GB of free disk space. That holds only a handful of videos."
  fi
}

check_ports() {
  command -v ss > /dev/null || return 0
  local other
  other=$(ss -H -ltnp '( sport = :80 or sport = :443 )' 2> /dev/null | grep -v '"caddy"' || true)
  [ -z "$other" ] || die "something other than Caddy is already listening on port 80 or 443, so HTTPS cannot be set up:
$other
Stop it (for example: sudo systemctl disable --now nginx apache2) and run the installer again."
}

# Caddy asks for the certificate as soon as it starts. If the domain does not point here yet, the request fails and
# repeated failures are rate-limited, so check first.
check_dns() {
  local d=${S[DOMAIN]} v4 v6 mine a
  if [ "${S[SKIP_DNS_CHECK]}" = yes ]; then warn "skipping the check that $d points at this server (SKIP_DNS_CHECK=yes)."; return 0; fi
  v4=$(getent ahostsv4 "$d" 2> /dev/null | awk '{print $1}' | sort -u || true)
  [ -n "$v4" ] || die "$d does not resolve to any address yet.
In your domain's DNS settings add an A record for $d that points to this server's public IP address, wait a few
minutes, and run the installer again. (If DNS is set up and this check is wrong, add SKIP_DNS_CHECK=yes to your settings file.)"
  mine=" $(hostname -I 2> /dev/null || true) "
  for a in $v4; do
    case "$mine" in *" $a "*) return 0 ;; esac
  done
  die "$d points to $(echo "$v4" | tr '\n' ' ')but this server's own addresses are:${mine}
Point the A record at this server, wait a few minutes, and run the installer again. If your host gives this server a
private address and maps a public one to it, or you know the check is wrong, add SKIP_DNS_CHECK=yes to your settings file.
(If you use Cloudflare, set the record to \"DNS only\": the free plan is not meant for serving video.)"
}

check_dns_v6() {
  local d=${S[DOMAIN]} v6 mine a found=no
  [ "${S[SKIP_DNS_CHECK]}" = yes ] && return 0
  v6=$(getent ahostsv6 "$d" 2> /dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u || true)
  [ -n "$v6" ] || return 0
  mine=" $(hostname -I 2> /dev/null || true) "
  for a in $v6; do case "$mine" in *" $a "*) found=yes ;; esac; done
  [ "$found" = yes ] || warn "$d also has an IPv6 (AAAA) record that does not match this server ($(echo "$v6" | tr '\n' ' ')). The certificate authority may use it and fail. Remove that record or point it here."
}

verify_source() {
  [ -f "$SRC/package.json" ] && grep -q '"name": "vidverse"' "$SRC/package.json" && [ -f "$SRC/package-lock.json" ] && [ -f "$SRC/src/server.js" ] \
    || die "$SRC does not look like the Vidverse project folder. Run the installer from inside the unpacked project: ./deploy/install.sh"
}

# ---------------------------------------------------------------------------------------------------- system

install_packages() {
  say "Installing system packages (PostgreSQL, ffmpeg, Caddy, and tools)"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
  apt-get update -qq
  # (Output is captured first: "grep -q" closing a pipe early would make this fail under pipefail.)
  local policy ufw_status=""
  policy=$(apt-cache policy caddy 2> /dev/null || true)
  [[ $policy == *"Candidate: "[0-9]* ]] || die "the 'caddy' package is not available. Turn on the 'universe' repository (sudo add-apt-repository universe), then run the installer again."
  apt-get install -y -qq postgresql ffmpeg caddy rsync xz-utils curl ca-certificates openssl
  if command -v ufw > /dev/null; then ufw_status=$(ufw status 2> /dev/null || true); fi
  if [[ $ufw_status == *"Status: active"* ]]; then
    note "ufw is on: allowing web traffic on ports 80 and 443"
    ufw allow 80/tcp > /dev/null
    ufw allow 443/tcp > /dev/null
    ufw allow 443/udp > /dev/null
  fi
}

ensure_user() {
  if ! id "$APP_USER" > /dev/null 2>&1; then
    say "Creating the unprivileged user '$APP_USER'"
    useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR"
  install -d -o root -g "$APP_USER" -m 750 "$ETC_DIR"
  install -d -o root -g root -m 755 "$APP_DIR" "$APP_DIR/releases"
}

# Is $1 a Node.js program of at least $NODE_MIN that the site's own user can run?
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  local v
  v=$(runuser -u "$APP_USER" -- "$1" -p 'process.versions.node' 2> /dev/null) || return 1
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -1)" = "$NODE_MIN" ]
}

ensure_node() {
  NODE_BIN=$(command -v node || true)
  if node_ok "$NODE_BIN"; then
    say "Node.js $("$NODE_BIN" -v) found at $NODE_BIN"
    return 0
  fi
  say "Installing Node.js 22 from nodejs.org"
  local arch tmp line sum file dir
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 --connect-timeout 20 "$NODE_DIST_BASE/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || die "could not download the Node.js checksum list from $NODE_DIST_BASE. Check that this server can reach the internet, or install Node.js 22.12 or newer yourself and run the installer again."
  line=$(grep -E "^[0-9a-f]{64}  node-v22\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz\$" "$tmp/SHASUMS256.txt" | head -1 || true)
  [ -n "$line" ] || die "the Node.js release list has no linux-$arch build. Install Node.js 22.12 or newer yourself and run the installer again."
  sum=${line%% *}
  file=${line##* }
  curl -fSL --retry 3 --connect-timeout 20 "$NODE_DIST_BASE/$file" -o "$tmp/$file" || die "could not download $file."
  (cd "$tmp" && echo "$sum  $file" | sha256sum -c --status) || die "the Node.js download does not match the checksum that nodejs.org publishes. Nothing was installed."
  dir=$NODE_INSTALL_ROOT/${file%.tar.xz}   # the file name was matched against a strict pattern above: no slashes in it
  mkdir -p "$NODE_INSTALL_ROOT" "$BIN_LINK_DIR"
  rm -rf "$dir"
  tar -xJf "$tmp/$file" -C "$NODE_INSTALL_ROOT" --no-same-owner
  ln -sfn "$dir" "$NODE_INSTALL_ROOT/node"
  ln -sf "$NODE_INSTALL_ROOT/node/bin/node" "$BIN_LINK_DIR/node"
  ln -sf "$NODE_INSTALL_ROOT/node/bin/npm" "$BIN_LINK_DIR/npm"
  ln -sf "$NODE_INSTALL_ROOT/node/bin/npx" "$BIN_LINK_DIR/npx"
  rm -rf "$tmp"
  NODE_BIN=$BIN_LINK_DIR/node
  node_ok "$NODE_BIN" || die "installed Node.js, but $NODE_BIN does not run for the '$APP_USER' user."
  note "installed $("$NODE_BIN" -v) in $dir"
}

# ---------------------------------------------------------------------------------------------------- database

psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }

ensure_database() {
  say "Setting up the database"
  systemctl enable --now postgresql > /dev/null 2>&1 || true
  local i
  for ((i = 0; i < 30; i++)); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
  runuser -u postgres -- pg_isready -q || die "PostgreSQL is not answering. Look at: sudo systemctl status postgresql"

  # A database that already holds tables, with no settings file, means the encryption keys that go with it are gone.
  # Starting over with new keys would make stored payout details unreadable, so refuse and let a human decide.
  if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = 'vidverse'")" = 1 ]; then
    local tables
    tables=$(runuser -u postgres -- psql -X -q -d vidverse -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
    [ "$tables" = 0 ] || die "a database named 'vidverse' with data in it already exists, but $ENV_FILE is missing.
A new settings file would have new encryption keys, and the old data could not be fully read. Restore $ENV_FILE from your
backup. If you really want to start from nothing, delete the database yourself first:  sudo -u postgres dropdb vidverse"
  fi

  DB_PASSWORD=$(openssl rand -hex 24)
  if [ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'vidverse'")" = 1 ]; then
    echo "ALTER ROLE vidverse LOGIN PASSWORD '$DB_PASSWORD'" | psql_admin
  else
    echo "CREATE ROLE vidverse LOGIN PASSWORD '$DB_PASSWORD'" | psql_admin
  fi
  if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = 'vidverse'")" != 1 ]; then
    psql_admin -c 'CREATE DATABASE vidverse OWNER vidverse'
  fi
}

write_env() {
  say "Writing $ENV_FILE (new secrets, generated here)"
  local tmp session keys key
  q() { env_quote "$1"; }
  session=$(openssl rand -base64 48 | tr -d '\n')
  key=$(openssl rand -base64 32 | tr -d '\n')
  keys="k1:$key"
  tmp=$(mktemp)
  cat > "$tmp" << EOF
# Vidverse settings. Written by deploy/install.sh on $(date -u +%Y-%m-%d). See .env.example in the project for every option.
# After editing:  sudo systemctl restart vidverse-web vidverse-worker
#
# KEEP A COPY OF THIS FILE SOMEWHERE SAFE, apart from the server (a password manager is fine).
# ENCRYPTION_KEYS is needed to read stored payout details, and a restored database is not enough without it.

NODE_ENV=production
BASE_URL=https://${S[DOMAIN]}
SITE_NAME=$(q "${S[SITE_NAME]}")
PORT=$PORT
HOST=127.0.0.1
TRUST_PROXY=1
LOG_LEVEL=info
DATA_DIR=$DATA_DIR

SESSION_SECRET=$(q "$session")
ENCRYPTION_KEYS=$(q "$keys")

DATABASE_URL=postgres://vidverse:$DB_PASSWORD@127.0.0.1:5432/vidverse
DATABASE_SSL=false

SMTP_URL=$(q "${S[SMTP_URL]}")
MAIL_FROM=$(q "${S[MAIL_FROM]}")

# The website and the video worker run as two services.
WORKER=separate
TRANSCODE_PROFILE=${S[TRANSCODE_PROFILE]}
MAX_UPLOAD_BYTES=${S[MAX_UPLOAD_BYTES]}
MAX_VIDEO_SECONDS=${S[MAX_VIDEO_SECONDS]}
DAILY_UPLOAD_LIMIT=${S[DAILY_UPLOAD_LIMIT]}
CREATOR_STORAGE_QUOTA_BYTES=${S[CREATOR_STORAGE_QUOTA_BYTES]}

# Google AdSense: leave empty until Google has approved the site (docs/MONETIZATION.md).
ADSENSE_CLIENT=
ADSENSE_SLOT_WATCH_TOP=
ADSENSE_SLOT_WATCH_SIDE=
ADS_TXT=

# Tips and payouts stay off until you have had advice on payment rules (docs/MONETIZATION.md).
PAYMENTS_PROVIDER=off

ANTHROPIC_API_KEY=$(q "${S[ANTHROPIC_API_KEY]}")

OPERATOR_NAME=$(q "${S[OPERATOR_NAME]}")
OPERATOR_ADDRESS=$(q "${S[OPERATOR_ADDRESS]}")
CONTACT_EMAIL=$(q "${S[CONTACT_EMAIL]}")
GRIEVANCE_OFFICER_NAME=$(q "${S[GRIEVANCE_OFFICER_NAME]}")
GRIEVANCE_OFFICER_EMAIL=$(q "${S[GRIEVANCE_OFFICER_EMAIL]}")
LEGAL_JURISDICTION=$(q "${S[LEGAL_JURISDICTION]}")

# The legal pages are templates. The site shows a "draft" notice on them until a lawyer has reviewed them: then set
# LEGAL_REVIEWED=true and ALLOW_UNREVIEWED_LEGAL=false.
LEGAL_REVIEWED=false
ALLOW_UNREVIEWED_LEGAL=true
EOF
  install -m 640 -o root -g "$APP_USER" "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

# ---------------------------------------------------------------------------------------------------- code

deploy_release() {
  say "Installing the code"
  local stamp rel
  stamp=$(date -u +%Y%m%d-%H%M%S)
  rel=$APP_DIR/releases/$stamp
  [ ! -e "$rel" ] || die "$rel already exists; wait a second and run the installer again."
  install -d -m 755 "$rel"
  (cd "$SRC" && tar -cf - package.json package-lock.json src public content scripts deploy docs README.md .env.example) | tar -xf - -C "$rel" --no-same-owner
  chmod -R u=rwX,go=rX "$rel"
  note "installing dependencies (a minute or two)"
  (cd "$rel" && PATH="$(dirname "$NODE_BIN"):$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) \
    || { rm -rf "$rel"; die "npm could not install the dependencies. Check that this server can reach the internet (registry.npmjs.org). Nothing has been changed."; }
  NEW_RELEASE=$rel
}

switch_release() {
  PREVIOUS_RELEASE=""
  [ -L "$APP_DIR/current" ] && PREVIOUS_RELEASE=$(readlink -f "$APP_DIR/current")
  ln -sfn "$NEW_RELEASE" "$APP_DIR/current.new"
  mv -T "$APP_DIR/current.new" "$APP_DIR/current"
}

prune_releases() {
  local keep=3 i=0 d cur
  cur=$(readlink -f "$APP_DIR/current")
  for d in $(printf '%s\n' "$APP_DIR"/releases/*/ | sort -r); do
    d=${d%/}
    i=$((i + 1))
    [ "$i" -le "$keep" ] && continue
    [ "$(readlink -f "$d")" = "$cur" ] && continue
    rm -rf -- "$d"
  done
}

render() { # render <file> : print the file with @NODE@ filled in
  local content
  content=$(< "$1")
  printf '%s\n' "${content//@NODE@/$NODE_BIN}"
}

install_services() {
  say "Installing the services (website, worker, nightly backup) and the 'vidverse' command"
  local f
  for f in vidverse-web.service vidverse-worker.service vidverse-backup.service vidverse-backup.timer; do
    render "$HERE/$f" > "/etc/systemd/system/$f"
    chmod 644 "/etc/systemd/system/$f"
  done
  install -m 755 -o root -g root "$HERE/vidverse-backup" /usr/local/sbin/vidverse-backup
  render "$HERE/vidverse" > /usr/local/bin/vidverse
  chmod 755 /usr/local/bin/vidverse
  systemctl daemon-reload
  systemctl enable vidverse-web vidverse-worker vidverse-backup.timer > /dev/null 2>&1
}

# ---------------------------------------------------------------------------------------------------- web server

configure_web_server() {
  say "Setting up the web server (HTTPS)"
  local domain acme
  domain=$(env_value BASE_URL); domain=${domain#https://}
  acme=${S[ACME_EMAIL]:-$(env_value CONTACT_EMAIL)}
  acme=${acme//\'/}

  if [ -e "$CADDYFILE" ] && grep -q 'Vidverse installer' "$CADDYFILE"; then
    note "$CADDYFILE was written by this installer before; leaving it as it is"
  else
    if [ -e "$CADDYFILE" ] && [ ! -e "$CADDYFILE.before-vidverse" ]; then cp -p "$CADDYFILE" "$CADDYFILE.before-vidverse"; fi
    local content
    content=$(< "$HERE/Caddyfile.template")
    content=${content//@DATE@/$(date -u +%Y-%m-%d)}
    content=${content//@ACME_EMAIL@/$acme}
    content=${content//@DOMAIN@/$domain}
    printf '%s\n' "$content" > "$CADDYFILE"
    chmod 644 "$CADDYFILE"
  fi

  # The password gate. First install only; afterwards 'sudo vidverse gate on|off' owns this file.
  if [ ! -e "$GATE_FILE" ]; then
    echo "# Written by the installer. 'sudo vidverse gate on' turns the closed-beta password on." > "$GATE_FILE"
    chown root:caddy "$GATE_FILE" 2> /dev/null || true
    chmod 640 "$GATE_FILE"
    if [ "${S[BETA_GATE]:-on}" = on ]; then
      echo
      VIDVERSE_NO_RELOAD=1 /usr/local/bin/vidverse gate on ${S[BETA_PASSWORD]:+"${S[BETA_PASSWORD]}"}
      GATE_ON=yes
    fi
  fi
  caddy validate --config "$CADDYFILE" --adapter caddyfile > /dev/null 2>&1 \
    || { caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -5; die "the web server did not accept its configuration ($CADDYFILE). The original is saved as $CADDYFILE.before-vidverse."; }
  systemctl enable caddy > /dev/null 2>&1 || true
  # The package starts Caddy with its own sample page; a reload switches it to this configuration without dropping connections.
  systemctl reload caddy 2> /dev/null || systemctl restart caddy
}

# ---------------------------------------------------------------------------------------------------- start

wait_for_site() {
  local i
  for ((i = 0; i < 90; i++)); do
    curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

show_logs() {
  if command -v journalctl > /dev/null; then journalctl -u "$1" -n 40 --no-pager 2> /dev/null | sed 's/^/    /' || true; fi
}

start_services() {
  say "Starting the website and the worker"
  PORT=$(env_value PORT); PORT=${PORT:-3000}
  systemctl stop vidverse-worker 2> /dev/null || true
  systemctl restart vidverse-web
  if ! wait_for_site; then
    echo "The website did not answer within 90 seconds. Its log says:" >&2
    show_logs vidverse-web >&2
    if [ -n "${PREVIOUS_RELEASE:-}" ]; then
      die "the new version did not start. If the log above names a setting, fix it in $ENV_FILE and run:
  sudo systemctl restart vidverse-web vidverse-worker
If the new code itself is at fault, the old version is still in $PREVIOUS_RELEASE. To go back:
  sudo ln -sfn $PREVIOUS_RELEASE $APP_DIR/current && sudo systemctl restart vidverse-web vidverse-worker
(database changes are not undone by this; restore a backup from /var/backups/vidverse if the old version cannot read the data)"
    fi
    die "the website did not start. Fix what the log above says (most often a setting in $ENV_FILE), then run:  sudo systemctl restart vidverse-web"
  fi
  systemctl restart vidverse-worker
  systemctl enable --now vidverse-backup.timer > /dev/null 2>&1 || true
  note "the website answers on 127.0.0.1:$PORT"
}

check_https() {
  local domain=$1 i
  say "Checking HTTPS (the certificate is requested when the web server starts; this can take a minute)"
  for ((i = 0; i < 45; i++)); do
    if curl -fsS --max-time 5 -o /dev/null "https://$domain/api/health" 2> /dev/null; then
      note "https://$domain answers with a valid certificate"
      return 0
    fi
    sleep 2
  done
  warn "https://$domain did not answer from here yet. That is normal if DNS changed a moment ago or this host cannot reach its own public address. Look at:  sudo vidverse logs caddy
(the certificate authority needs to reach this server on ports 80 and 443 from the internet; check your host's firewall)"
  return 0
}

check_mail() {
  say "Sending a test email to ${S[CONTACT_EMAIL]:-$(env_value CONTACT_EMAIL)}"
  local to=${S[CONTACT_EMAIL]:-$(env_value CONTACT_EMAIL)}
  if /usr/local/bin/vidverse mail-test "$to"; then
    return 0
  fi
  warn "the test email could not be sent. Sign-up confirmation and password reset will not work until this is fixed.
Edit SMTP_URL and MAIL_FROM in $ENV_FILE, then run:  sudo systemctl restart vidverse-web vidverse-worker  and  sudo vidverse mail-test $to"
  return 0
}

# ---------------------------------------------------------------------------------------------------- main

main() {
  case "${1:-}" in -h | --help) usage; exit 0 ;; esac
  need_root
  umask 022
  export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  local settings_file=${1:-} first=no
  GATE_ON=no
  check_os
  verify_source

  if [ -e "$ENV_FILE" ]; then
    say "Update: $ENV_FILE exists, so the settings are kept and only the code is updated"
    [ -z "$settings_file" ] || warn "ignoring $settings_file: edit $ENV_FILE to change a setting."
  else
    first=yes
    [ -n "$settings_file" ] || die "no settings file given. First install:
  cp deploy/setup.conf.example ~/vidverse-setup.conf
  nano ~/vidverse-setup.conf
  sudo ./deploy/install.sh ~/vidverse-setup.conf"
    read_settings "$settings_file"
    apply_defaults
    validate_settings
  fi
  check_resources
  if [ "$first" = yes ]; then
    check_ports
    check_dns
    check_dns_v6
  fi

  install_packages
  ensure_user
  ensure_node
  if [ "$first" = yes ]; then
    ensure_database
    write_env
  elif [ "${SKIP_BACKUP:-no}" != yes ]; then
    say "Backing up before the update"
    if [ -x /usr/local/sbin/vidverse-backup ]; then
      /usr/local/sbin/vidverse-backup || die "the backup failed, so the update was not started. Fix that first (or run with SKIP_BACKUP=yes if you accept the risk)."
    else
      warn "no backup tool is installed yet; continuing without a backup."
    fi
  fi
  deploy_release
  install_services
  switch_release
  configure_web_server
  start_services
  prune_releases

  local domain
  domain=$(env_value BASE_URL); domain=${domain#https://}
  check_https "$domain"
  [ "$first" = yes ] && check_mail

  say "Done"
  note "Your site: https://$domain"
  if [ "$first" = yes ]; then
    cat << EOF

What to do next:
  1. If the test email above did not arrive (look in spam too), fix SMTP_URL first:  sudo vidverse mail-test you@yourmail.com
  2. Open https://$domain, sign up with your own email address, and click the link in the confirmation email.
  3. Make yourself the administrator:  sudo vidverse make-admin you@yourmail.com
  4. In the site, open Settings > Security and turn on two-step verification.
  5. Copy $ENV_FILE and /var/backups/vidverse to a place that is not this server.
  6. Read docs/DEPLOYMENT.md, "Before you open the site to the public".

Everyday commands:  sudo vidverse status | logs | backup | restore FOLDER | gate on|off | make-admin EMAIL | mail-test EMAIL
EOF
    if [ "$GATE_ON" = yes ]; then
      echo
      echo "The site is behind a shared password (user name beta) until you run:  sudo vidverse gate off"
    else
      echo
      echo "BETA_GATE is off: anyone who finds the address can sign up. The legal pages still carry the draft notice."
    fi
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
