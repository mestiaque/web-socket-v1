# Local development and VPS deployment

For cPanel hosting see [CPANEL.md](CPANEL.md).

## Requirements

- Node.js LTS ≥ 20.12 (22 or 24 recommended; Node 20 reached end-of-life in
  April 2026). Development and the test results in this repository used
  Node 20.18.1 on Linux; CI runs Node 22 and 24.
- npm (ships with Node).

## Local development

```bash
git clone <repo> dynamicsocket && cd dynamicsocket
npm ci

cp .env.example .env
cp apps.example.json apps.json
npm run app:generate -- --id shop --key k1 --origin http://localhost:8000
#   -> append the printed DS_SHOP_SECRET_K1=... line to .env
#   -> edit apps.json: keep the "shop" entry, set "keys" to [{"id":"k1","secretEnv":"DS_SHOP_SECRET_K1"}]
#      and remove apps you do not need (each secretEnv must be set)

npm run dev          # node --watch src/server.js
curl localhost:6001/healthz
```

Try it end to end in a second terminal:

```bash
TOKEN=$(npm run -s token:issue -- --app shop --sub 1 --channels orders)
# connect with any WebSocket client, e.g. the browser demo below, then:
npm run publish:signed -- --app shop --channel orders --event order.created --data '{"order_id":1}'
```

Browser demo (development only):

```bash
# add "http://localhost:8080" to the app's allowedOrigins and restart, then
node examples/browser/dev-backend.js --app shop --port 8080
# open http://localhost:8080
```

Tests and lint:

```bash
npm test             # all suites (unit, integration, security)
npm run test:unit
npm run lint
```

### Docker (local)

```bash
cp .env.example .env && cp apps.example.json apps.json   # configure as above
docker compose up --build
```

The compose file publishes the port on `127.0.0.1:6001` only.

Verified with `npm run test:docker` (`tests/docker/smoke.sh`) on Docker 29.9.1
/ Compose v5.6.0, Ubuntu 22.04 (2026-10-17): image builds (~247 MB,
`node:24-alpine`, Node 24.22.0 inside), `/healthz` and the Docker
HEALTHCHECK report healthy, the process runs as the non-root `node` user, the
image contains no tests, `.env` or dev dependencies, a WebSocket auth +
presence + signed publish round trip works through the published port,
`docker stop` shuts down gracefully with exit code 0, secrets do not appear
in container logs, and `docker compose up/down` works with a mounted
`apps.json` and `.env`.

## VPS deployment (Ubuntu/Debian, systemd + nginx)

### 1. Install Node.js LTS and nginx

Install Node.js from your distribution, NodeSource, or the official
binaries. Then:

```bash
sudo apt install nginx
node --version   # >= 20.12
```

### 2. User and files

```bash
sudo useradd --system --home /opt/dynamicsocket --shell /usr/sbin/nologin dynamicsocket
sudo mkdir -p /opt/dynamicsocket /etc/dynamicsocket
sudo chown -R $USER /opt/dynamicsocket
git clone <repo> /opt/dynamicsocket
cd /opt/dynamicsocket && npm ci --omit=dev
```

### 3. Configuration

```bash
node scripts/generate-app.js --id shop --key k1 --origin https://shop.example.com
sudoedit /etc/dynamicsocket/apps.json            # entries with "secretEnv"
sudoedit /etc/dynamicsocket/dynamicsocket.env
```

`/etc/dynamicsocket/dynamicsocket.env`:

```dotenv
DS_HOST=127.0.0.1
DS_PORT=6001
DS_WS_PATH=/ws
DS_APPS_FILE=/etc/dynamicsocket/apps.json
DS_TRUSTED_PROXIES=127.0.0.1
DS_LOG_LEVEL=info
DS_METRICS_TOKEN=<random string, 16+ chars>
DS_SHOP_SECRET_K1=<generated secret>
```

```bash
sudo chown root:dynamicsocket /etc/dynamicsocket/*
sudo chmod 640 /etc/dynamicsocket/*
```

### 4. systemd

```bash
sudo cp deploy/dynamicsocket.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dynamicsocket
systemctl status dynamicsocket
journalctl -u dynamicsocket -f
curl -s localhost:6001/healthz
```

The unit sends SIGTERM on stop/restart; DynamicSocket closes clients with
`1001` and exits within `DS_SHUTDOWN_TIMEOUT_MS`. `LimitNOFILE=65536` raises
the file-descriptor limit (one per socket).

### 5. nginx + TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/dynamicsocket
sudo ln -s /etc/nginx/sites-available/dynamicsocket /etc/nginx/sites-enabled/
# edit server_name / certificate paths
sudo certbot --nginx -d ws.example.com     # or your ACME client
sudo nginx -t && sudo systemctl reload nginx
```

Key points in `deploy/nginx.conf`: `Upgrade`/`Connection` headers,
`proxy_http_version 1.1`, `proxy_read_timeout` longer than the heartbeat
interval, `X-Forwarded-For $remote_addr` (overwrite), `/metrics` not exposed.

DNS: an `A`/`AAAA` record for `ws.example.com` pointing to the VPS. Firewall:
allow 80/443 only; port 6001 stays on loopback.

### 6. Laravel on another server

Set `DYNAMICSOCKET_HTTP_URL=https://ws.example.com` and keep the `/v1/`
location in nginx. Optionally restrict `/v1/` to the Laravel server's IP with
`allow`/`deny` in nginx — the HMAC signature remains the actual
authentication.

### 7. Upgrades

```bash
cd /opt/dynamicsocket && git pull && npm ci --omit=dev
npm test   # optional on the server (requires dev deps: npm ci)
sudo systemctl restart dynamicsocket
```

Restarts drop all sockets; the SDK reconnects automatically.

### 8. Monitoring

- Liveness: `GET /healthz`; readiness: `GET /readyz`.
- Prometheus: scrape `http://127.0.0.1:6001/metrics` with
  `Authorization: Bearer $DS_METRICS_TOKEN`. Useful series:
  `ds_connections`, `ds_auth_failures_total`, `ds_frames_dropped_total`,
  `ds_slow_consumer_disconnects_total`, `ds_http_auth_failures_total`,
  `ds_publish_rate_limited_total`, `ds_nonce_store_size`.

### Running more than one instance

Not supported in 0.1 (see ARCHITECTURE.md → Scaling). Run one process per
deployment; scale vertically first.
