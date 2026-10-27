# Kompass on the workshop server

Kompass runs on the team's hessian.AI workshop VM (wsvm44), next to Abdul's stack in `/srv/app`:

- **http://130.83.85.181:44080/kompass/**: through the dashboard's nginx (VM port 80).
- **https://130.83.85.181:44443**: Kompass's own HTTPS proxy on VM port 443. It uses the team's self-signed certificate, so the browser warns once. Its root forwards to `/kompass/`.

## How it fits together

| Part | Where | What it does |
|---|---|---|
| `kompass-live` container | Compose project `kompass-live`, from `deploy/docker-compose.yml` | The workspace server. It also serves the web app, built for the path `/kompass/`. |
| `kompass-live-tls` container | Same project, VM port 443 | nginx with the certificate from `~/nba-certs`. It uses the same route as below (`nginx-tls.conf` includes `nginx-kompass.conf`). |
| The dashboard's nginx (`app-dashboard-1`, Abdul's) | VM port 80, public as `:44080` | Gets an extra route: `/kompass/` goes to `kompass-live:8787` (`deploy/nginx-kompass.conf`). |
| Insights service (`service`, Abdul's) | Docker network `app_default` | Kompass reads it at `http://service:8100`, without going through the internet. |
| Workspace and logs | Docker volume `kompass-live_kompass-data`, on the data disk | Survive a redeploy. Logs: `docker exec kompass-live tail -f /data/logs/kompass.log`. |
| Assistant settings | `~/kompass-src/deploy/.env` on the VM, readable only by the VM user | `API_URL`, `MODEL`, `BEARER`, copied from your local `.env`. They are never baked into the image. |

**Why it is set up this way:**
- The only public ports are 80 and 443. Port 80 is Abdul's dashboard, so Kompass is a route in his nginx there.
- Port 443 was the NBA app. A test deploy of Kompass took it over on 27.10.
- The names `kompass-live*` are deliberate: an old deploy script that uses the name `kompass` cannot replace this one.

## Deploy

**Once, on your laptop:** a key for SSH.

```bash
ssh-keygen -t ed25519 -N "" -C "kompass-deploy wsvm44" -f ~/.ssh/kompass_wsvm44
ssh-copy-id -i ~/.ssh/kompass_wsvm44.pub -p 44022 wsvm44-admin@130.83.85.181
```

**Every deploy,** from the kompass folder:

```bash
bash deploy/deploy.sh
```

What `deploy.sh` does:
1. Uploads the sources to `~/kompass-src` on the VM.
2. Copies the assistant settings.
3. Removes old containers named `kompass` and `kompass-tls`.
4. Builds the image and (re)starts `kompass-live` and `kompass-live-tls`.
5. Waits until Kompass answers.
6. Puts the current route into the dashboard's nginx (`deploy/route.sh`).
7. Checks both public URLs.

The first build takes a few minutes; later builds take about a minute.

**If the script can't connect:** some networks block the VM. On 27.10. the venue Wi-Fi did, and a phone hotspot worked.

## The route in Abdul's nginx

How `route.sh` works:
- It puts `nginx-kompass.conf` into the running dashboard container, right before its `location / {`.
- It replaces an older Kompass block if there is one.
- It runs `nginx -t` and then reloads. If nginx rejects the change, the old config goes back.
- The original config is kept in `~/dashboard-nginx.conf.bak` on the VM.
- The route looks Kompass up per request. If Kompass is down, `/kompass/` answers 502, but the dashboard keeps working and nginx still starts.

**A redeploy of Abdul's stack drops the route**, because his image doesn't have it. To get it back:
- Run `bash deploy/deploy.sh` again.
- Or run only the route step:

  ```bash
  ssh -i ~/.ssh/kompass_wsvm44 -p 44022 wsvm44-admin@130.83.85.181 bash kompass-src/deploy/route.sh
  ```

To make it permanent, Abdul adds the contents of `deploy/nginx-kompass.conf` to `server-deploy/customer-intelligence/nginx.conf` in his repo, before `location / {`.

## Undo

Remove Kompass, including the HTTPS proxy:

```bash
ssh -i ~/.ssh/kompass_wsvm44 -p 44022 wsvm44-admin@130.83.85.181 'cd kompass-src/deploy && docker compose down'
```

Remove the route:

```bash
ssh -i ~/.ssh/kompass_wsvm44 -p 44022 wsvm44-admin@130.83.85.181 'docker cp ~/dashboard-nginx.conf.bak app-dashboard-1:/etc/nginx/conf.d/default.conf && docker exec app-dashboard-1 nginx -s reload'
```

Start the workspace fresh: `POST /kompass/api/workspace/reset`, or remove the volume.

## The desktop app

`desktop/main.mjs` opens Kompass in a window. Run these from the kompass folder:

| Command | What it opens |
|---|---|
| `npm run desktop:start` | Builds the web app first. If `npm run dev` is running, it opens that UI (same server, same workspace). Otherwise it starts its own server on 8787, or, when 8787 is taken, on a free port with its own workspace (`server/workspace.desktop.json`). |
| `npm run desktop:remote` | The team server, `http://130.83.85.181:44080/kompass/`. Only works on a network that can reach the VM. |
| `npm run desktop` | Dev mode: server, Vite and the window together. |

The local server reads the insights service at `http://130.83.85.181:44080/svc`, or at `INSIGHTS_URL` from `.env`. It reconnects on its own when the network comes back.

## Note

Anyone with the link can use Kompass, including the assistant, which runs on the team's LLM key. All the data is synthetic.
