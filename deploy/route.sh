#!/usr/bin/env bash
# Runs on the VM (deploy.sh calls it): puts the current /kompass/ route (nginx-kompass.conf) into the
# running dashboard nginx. Abdul's dashboard image does not have the route, so a redeploy of his stack
# drops it until this runs again.
set -euo pipefail
C=${DASHBOARD:-app-dashboard-1}
CONF=/etc/nginx/conf.d/default.conf
HERE=$(cd "$(dirname "$0")" && pwd)
SNIP=$HERE/nginx-kompass.conf
TARGET=$(grep -o 'set \$kompass [^;]*;' "$SNIP")

tmp=$(mktemp -d)
docker cp "$C:$CONF" "$tmp/old.conf"
if grep -q "# >>> kompass" "$tmp/old.conf" && grep -qF "$TARGET" "$tmp/old.conf"; then
  echo "route: already current in $C"
  exit 0
fi
[ -f "$HOME/dashboard-nginx.conf.bak" ] || cp "$tmp/old.conf" "$HOME/dashboard-nginx.conf.bak"

# Drop an older Kompass block: the marked one, or the first version (without markers), which ends
# with the closing brace of "location /kompass/".
awk '
  /# >>> kompass/ { skip = 1 }
  /# Kompass \(kompass\/deploy\)/ { legacy = 1 }
  legacy && /location \/kompass\/ \{/ { inloc = 1 }
  { if (!skip && !legacy) print }
  /# <<< kompass/ { skip = 0 }
  legacy && inloc && /^[[:space:]]*\}[[:space:]]*$/ { legacy = 0; inloc = 0 }
' "$tmp/old.conf" >"$tmp/clean.conf"
# The current block goes right before the catch-all "location / {" of the server block.
awk -v snip="$SNIP" '!done && /^[[:space:]]*location \/ \{/ { while ((getline l < snip) > 0) print l; print ""; done = 1 } { print }' "$tmp/clean.conf" >"$tmp/new.conf"
grep -qF "$TARGET" "$tmp/new.conf" || { echo "route: no 'location / {' in $C:$CONF, nothing changed"; exit 1; }

docker cp "$tmp/new.conf" "$C:$CONF"
if docker exec "$C" nginx -t && docker exec "$C" nginx -s reload; then
  echo "route: current block in $C, nginx reloaded (original config in ~/dashboard-nginx.conf.bak)"
else
  docker cp "$tmp/old.conf" "$C:$CONF"
  echo "route: nginx rejected the change, the old config is back"
  exit 1
fi
