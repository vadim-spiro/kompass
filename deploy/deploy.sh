#!/usr/bin/env bash
# Deploys Kompass to the team's workshop VM (hessian.AI wsvm44), next to Abdul's stack in /srv/app:
#   bash deploy/deploy.sh
# Public at http://130.83.85.181:44080/kompass/ (through the dashboard's nginx) and
# https://130.83.85.181:44443 (self-signed certificate). README.md explains the setup.
set -euo pipefail
cd "$(dirname "$0")/.."                        # the kompass folder

HOST=${SSH_HOST:-130.83.85.181}
PORT=${SSH_PORT:-44022}
USER_=${SSH_USER:-wsvm44-admin}
KEY=${SSH_KEY:-$HOME/.ssh/kompass_wsvm44}
REMOTE=/home/$USER_/kompass-src                # build context only; image, volume and logs live in /srv/docker
CERTS=/home/$USER_/nba-certs                   # the team's self-signed certificate for port 443
SSH=(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
[ -f "$KEY" ] && SSH+=(-i "$KEY")
SSH+=("$USER_@$HOST")
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "connecting to $USER_@$HOST:$PORT"
if ! err=$("${SSH[@]}" true 2>&1); then
  case $err in
    *"timed out"* | *"No route"* | *"Connection refused"*) echo "Can't reach $HOST:$PORT from this network ($err). Some networks block it; a phone hotspot worked on 27.10." ;;
    *) echo "No key-based SSH access to $USER_@$HOST ($err). See deploy/README.md." ;;
  esac
  exit 1
fi

log "uploading the sources to $REMOTE"
COPYFILE_DISABLE=1 tar -czf - --no-xattrs --no-fflags --exclude node_modules --exclude .DS_Store --exclude web/dist \
  --exclude server/logs --exclude server/workspace.json --exclude server/data --exclude deploy/.env \
  Dockerfile .dockerignore api shared server web deploy maingau_nba_mockdata_csv_jsonl event_stream_2026-10-01.jsonl |
  "${SSH[@]}" "rm -rf $REMOTE && mkdir -p $REMOTE && tar -xzf - -C $REMOTE"

# Only the assistant's settings: the insights URL on the VM is set in docker-compose.yml.
if [ -f .env ]; then
  grep -E '^(API_URL|MODEL|BEARER)=' .env | "${SSH[@]}" "umask 077 && cat > $REMOTE/deploy/.env"
  log "assistant settings copied (deploy/.env on the VM, readable only by $USER_)"
else
  log "no .env here: Kompass runs without the assistant"
fi

# Earlier deploys under the name "kompass" (a test from an older checkout) hold port 443; they go.
"${SSH[@]}" 'old=$(docker ps -aq --filter name=^kompass$ --filter name=^kompass-tls$); [ -z "$old" ] || { docker rm -f $old >/dev/null && echo "removed the old kompass containers"; }'

log "building and starting (the first build takes a few minutes)"
"${SSH[@]}" "cd $REMOTE/deploy && CERT_DIR=$CERTS docker compose up -d --build --remove-orphans 2>&1 | grep -vE '^ *#[0-9]+ ' | tail -15"

log "waiting for Kompass to answer"
"${SSH[@]}" 'for i in $(seq 1 45); do
  docker exec kompass-live node -e "fetch(\"http://localhost:8787/api/status\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { docker logs kompass-live 2>&1 | grep "^\[kompass\]" | tail -4; exit 0; }
  sleep 2
done
echo "Kompass did not come up:"; docker logs --tail 40 kompass-live; exit 1'

log "the /kompass/ route in the dashboard's nginx"
"${SSH[@]}" "bash $REMOTE/deploy/route.sh"

ok=1
for url in "http://$HOST:44080/kompass/" "https://$HOST:44443/kompass/"; do
  code=$(curl -sk -o /dev/null -m 15 -w '%{http_code}' "${url}api/status" || true)
  log "public check: ${url}api/status answered $code"
  [ "$code" = 200 ] || ok=0
done
[ $ok = 1 ] && log "done: http://$HOST:44080/kompass/ and https://$HOST:44443/"
