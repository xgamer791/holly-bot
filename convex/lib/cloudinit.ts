// The cloud-init script a subscriber's server runs once, as root, when it
// first boots (convex/servers.ts sends it as the server's user_data). It sets
// up Holly Computer, unattended:
//   1. Caddy for HTTPS, Node.js 22 (nodejs.org, checked against its
//      checksums), and Google Chrome for the bots' browser.
//   2. When the server replaces a bigger one (a downgrade), the bots' files
//      from the old server: its workspace, browser profile and plugins.
//   3. Holly Computer as a service, which links itself to the subscriber's
//      account with a one-time code (the link-code file) and keeps their bots
//      there, like any linked Holly Computer.
//   4. Caddy in front of it at https://<ip>.sslip.io (a name that always
//      points at this address), with a Let's Encrypt certificate, so the app
//      can reach it from the Holly Bot site (over HTTP/1.1 or HTTP/2).
// Then it calls POST /servers/ready on Holly Bot's deployment with the
// one-time ready token, the address and the pairing token, or with what went
// wrong. Everything it does is logged in /var/log/holly-setup.log. No imports.

export interface SetupOptions {
  userId: string;
  /** Where to report: https://<deployment>.convex.site/servers/ready */
  readyUrl: string;
  /** The one-time token the report must carry. */
  readyToken: string;
  /** The one-time code that links Holly Computer to the account. */
  linkCode: string;
  /** The Holly Bot site, which serves the current Holly Computer. */
  site: string;
  /** What the server is called in the app. */
  name: string;
  /** The server this one replaces, to take the bots' files from. */
  from?: { url: string; token: string };
}

/** A value in single quotes for bash. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function setupScript(o: SetupOptions): string {
  const site = o.site.endsWith("/") ? o.site : `${o.site}/`;
  return `#!/bin/bash
# Holly Bot: sets this server up for one subscriber, unattended. Written by
# convex/lib/cloudinit.ts; cloud-init runs it once, as root, at first boot.
set -uo pipefail
exec >>/var/log/holly-setup.log 2>&1
echo "Holly setup started $(date -u)"

USER_ID=${q(o.userId)}
READY_URL=${q(o.readyUrl)}
READY_TOKEN=${q(o.readyToken)}
LINK_CODE=${q(o.linkCode)}
SITE=${q(site)}
NAME=${q(o.name)}
FROM_URL=${q(o.from?.url ?? "")}
FROM_TOKEN=${q(o.from?.token ?? "")}
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3 -y"

# apt, tried a few times: at first boot, Ubuntu's own daily apt run can have
# the package lists locked for a minute (installs wait for it; updates don't).
apt_try() {
  for i in 1 2 3 4 5 6; do
    $APT "$@" && return 0
    sleep 20
  done
  return 1
}

# Tells Holly Bot how it went (a JSON body), trying for a couple of minutes.
report() {
  for i in 1 2 3 4 5 6; do
    curl -fsS --max-time 30 -X POST -H 'Content-Type: application/json' --data "$1" "$READY_URL" && return 0
    sleep $((i * 10))
  done
  echo "Couldn't reach Holly Bot to report"
  return 1
}

fail() {
  echo "Holly setup failed: $1"
  report "$(python3 -c 'import json, sys; print(json.dumps({"userId": sys.argv[1], "token": sys.argv[2], "error": sys.argv[3][:400]}))' "$USER_ID" "$READY_TOKEN" "$1")"
  exit 1
}

echo "== Packages"
apt_try update || fail "Updating the package lists failed"
apt_try install ca-certificates curl gnupg tar xz-utils python3 || fail "Installing the basics failed"

echo "== Caddy"
curl -fsSL --retry 3 https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \\
  || fail "Couldn't get Caddy's signing key"
curl -fsSL --retry 3 -o /etc/apt/sources.list.d/caddy-stable.list https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt || fail "Couldn't add Caddy's packages"
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt_try update && apt_try install caddy || fail "Installing Caddy failed"

echo "== Node.js 22"
NODE_URL=https://nodejs.org/dist/latest-v22.x
SUMS=$(curl -fsSL --retry 3 "$NODE_URL/SHASUMS256.txt") || fail "Couldn't reach nodejs.org"
NODE_TAR=$(printf '%s\\n' "$SUMS" | awk '/-linux-x64\\.tar\\.xz$/ { print $2; exit }')
[ -n "$NODE_TAR" ] || fail "nodejs.org has no Node.js 22 for Linux x64"
curl -fsSL --retry 3 -o "/tmp/$NODE_TAR" "$NODE_URL/$NODE_TAR" || fail "Downloading Node.js failed"
(cd /tmp && printf '%s\\n' "$SUMS" | grep " $NODE_TAR\\$" | sha256sum -c -) || fail "Node.js didn't match its checksum"
tar -xJf "/tmp/$NODE_TAR" -C /usr/local --strip-components=1 || fail "Unpacking Node.js failed"
rm -f "/tmp/$NODE_TAR"

echo "== Chrome"
# Chrome comes last because it adds Google's package source to apt, which
# then can't get in the way of the installs above.
if curl -fsSL --retry 3 -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt_try install /tmp/chrome.deb; then
  echo "Chrome installed"
else
  echo "Chrome couldn't be installed; the bots will have no browser"
fi
rm -f /tmp/chrome.deb

echo "== Holly Computer"
id holly >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/holly --shell /bin/bash holly || fail "Couldn't make the holly user"
mkdir -p /opt/holly /var/lib/holly/data /var/lib/holly/workspace
curl -fsSL --retry 3 -o /opt/holly/holly-computer.mjs "\${SITE}computer/holly-computer.mjs" || fail "Downloading Holly Computer failed"
chown -R holly:holly /var/lib/holly /opt/holly

IP=$(curl -fsS --max-time 10 http://169.254.169.254/v1/interfaces/0/ipv4/address 2>/dev/null) || IP=""
case "$IP" in *.*.*.*) ;; *) IP=$(hostname -I | awk '{ print $1 }') ;; esac
[ -n "$IP" ] || fail "Couldn't find this server's IP address"
HOST="\${IP//./-}.sslip.io"
echo "Address: https://$HOST"

if [ -n "$FROM_URL" ]; then
  echo "== The bots' files, from the server this one replaces"
  MOVED=""
  # Unpacked as holly, not root: the archive comes from a server the bots ran on.
  for i in 1 2 3; do
    if curl -fsS --max-time 3600 -H "Authorization: Bearer $FROM_TOKEN" -o /tmp/holly-files.tgz "$FROM_URL/v1/export" \\
      && runuser -u holly -- tar -xzf /tmp/holly-files.tgz -C /var/lib/holly; then
      MOVED=1
      break
    fi
    sleep 30
  done
  rm -f /tmp/holly-files.tgz
  [ -n "$MOVED" ] || fail "Couldn't copy the bots' files from the old server"
fi

# Its name in the app, and the one-time code that links it to the account
# (Holly Computer spends it at start and deletes the file).
python3 -c 'import json, sys; json.dump({"name": sys.argv[1]}, open("/var/lib/holly/data/config.json", "w"))' "$NAME" || fail "Couldn't write Holly Computer's settings"
printf '%s' "$LINK_CODE" > /var/lib/holly/data/link-code
chmod 600 /var/lib/holly/data/config.json /var/lib/holly/data/link-code
chown -R holly:holly /var/lib/holly /opt/holly

cat > /etc/systemd/system/holly.service <<EOF
[Unit]
Description=Holly Computer
After=network-online.target
Wants=network-online.target

[Service]
User=holly
Group=holly
Environment=HOME=/var/lib/holly
WorkingDirectory=/var/lib/holly
# Each start runs the current Holly Computer, like every open of the app.
ExecStartPre=-/bin/sh -c 'curl -fsSL -o /opt/holly/holly-computer.mjs.new \${SITE}computer/holly-computer.mjs && mv /opt/holly/holly-computer.mjs.new /opt/holly/holly-computer.mjs'
ExecStart=/usr/local/bin/node /opt/holly/holly-computer.mjs --no-open --allow-sleep --port 8787 --data /var/lib/holly/data --workspace /var/lib/holly/workspace --public-url https://$HOST
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# HTTP/1.1 and HTTP/2 only. Caddy would also offer HTTP/3, which runs over
# UDP 443, and the firewall below opens TCP only: Safari, told to use it,
# keeps trying and the app's live updates fail. Alt-Svc: clear makes a
# browser forget an offer it kept from an earlier server at this address.
cat > /etc/caddy/Caddyfile <<EOF
{
  servers {
    protocols h1 h2
  }
}

$HOST {
  header Alt-Svc clear
  reverse_proxy 127.0.0.1:8787
}
EOF

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

systemctl daemon-reload
systemctl enable --now holly || fail "Holly Computer didn't start"
systemctl enable caddy && systemctl restart caddy || fail "Caddy didn't start"

echo "== Waiting for Holly Computer to link to the account and answer over HTTPS"
UP=""
for i in $(seq 1 120); do
  if [ -s /var/lib/holly/data/account.json ] && curl -fsS --max-time 10 "https://$HOST/v1/health" >/dev/null 2>&1; then
    UP=1
    break
  fi
  sleep 5
done
if [ -z "$UP" ]; then
  [ -s /var/lib/holly/data/account.json ] || fail "Holly Computer didn't link to the account"
  fail "Holly Computer isn't answering at https://$HOST"
fi

PAIRING=$(python3 -c 'import json; print(json.load(open("/var/lib/holly/data/config.json"))["token"])') || fail "Couldn't read Holly Computer's pairing token"
report "$(python3 -c 'import json, sys; print(json.dumps({"userId": sys.argv[1], "token": sys.argv[2], "url": sys.argv[3], "pairingToken": sys.argv[4]}))' "$USER_ID" "$READY_TOKEN" "https://$HOST" "$PAIRING")"
echo "Holly setup finished $(date -u)"
`;
}
