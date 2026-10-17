# Deploying on cPanel hosting

**Read this first.** DynamicSocket is a long-running process that holds open
WebSocket connections. It works on a cPanel account only if the host:

1. lets Node.js applications run as **persistent processes**, and
2. forwards **WebSocket Upgrade** requests from the public web server
   (Apache / LiteSpeed / nginx) to the Node.js process, and
3. runs **exactly one** process for the application (DynamicSocket keeps
   connections and subscriptions in memory).

Many shared hosting plans meet none or only some of these. Having Terminal
access and `npm` **does not** imply any of them. If your host does not provide
them, no change to DynamicSocket's code can make it reliable there; use a VPS
(see [DEPLOYMENT.md](DEPLOYMENT.md)) or ask the host for a plan that supports
them.

This guide has not been verified against a specific hosting provider. Menu
names differ between cPanel versions and CloudLinux / non-CloudLinux servers.
Treat each step as "check this", and use the verification checklist at the
end before relying on the deployment.

---

## 1. Check Node.js support

In cPanel look for **Software → Setup Node.js App** (CloudLinux Node.js
Selector) or **Software → Application Manager** (cPanel's Passenger-based
manager). If neither exists, Node.js apps are not supported on the account.

Ask the provider, in writing:

- Do Node.js apps run under Phusion Passenger (or something else)?
- Are **WebSocket** connections proxied to Node.js apps? On which web server
  (Apache, LiteSpeed)?
- How many processes are started per app, and can it be limited to **one**?
- Are idle apps stopped, and after how long? Are long-lived connections cut
  after a timeout?
- What are the memory, CPU, process and open-file limits?
- Is outbound/inbound traffic on custom ports allowed? (Usually not — you must
  go through the web server.)

## 2. Select the runtime

In *Setup Node.js App* → **Create Application**:

- **Node.js version:** the newest LTS offered (22 or 24; minimum 20.12).
- **Application mode:** Production.
- **Application root:** e.g. `dynamicsocket` (a directory outside `public_html`).
- **Application URL:** a dedicated subdomain, e.g. `ws.example.com`
  (create it first under *Domains*; see §8).
- **Application startup file:** `app.cjs`.

`app.cjs` exists because Passenger loads the startup file with `require()`;
it imports the ES module server.

## 3. Upload the code

Upload the repository contents (without `node_modules`, `.git`, `tests`) to
the application root via Git (*Git Version Control*), SFTP or File Manager.

## 4. Install dependencies from the lockfile

In cPanel's Terminal, enter the app's virtual environment (the *Setup Node.js
App* page shows the exact `source …/activate` command), then:

```bash
cd ~/dynamicsocket
npm ci --omit=dev
```

`npm ci` installs exactly what `package-lock.json` specifies. The only
runtime dependency is `ws`. The "Run NPM Install" button runs `npm install`,
which may update the lockfile; prefer `npm ci`.

## 5. Configure environment variables

Generate a secret:

```bash
node scripts/generate-app.js --id shop --key k1 --origin https://shop.example.com
```

Add variables in *Setup Node.js App → Environment variables* (they are not
stored in the web root), at minimum:

```
DS_APPS_FILE=/home/<user>/dynamicsocket-config/apps.json
DS_SHOP_SECRET_K1=<generated secret>
DS_WS_PATH=/ws
DS_LOG_LEVEL=info
```

Create `apps.json` **outside** `public_html` and the app root if possible,
with `secretEnv` references instead of literal secrets, and
`chmod 600 apps.json`. Do not commit it.

Alternatively place a `.env` file in the application root (`chmod 600`); real
environment variables override it.

## 6. Host and port

Under Passenger you do not choose the port: Passenger intercepts `listen()`
and connects the app to the web server through its own socket. DynamicSocket
accepts this (`DS_HOST`/`DS_PORT` are then ignored) and logs the bound address.

If your host instead runs Node.js apps on an assigned port behind a reverse
proxy, set `DS_PORT` (or `PORT`) to that port and `DS_HOST=127.0.0.1`.

## 7. Persistent processes, WebSocket upgrades and single instance

- **WebSocket support** depends on the Passenger version and web server
  integration chosen by the host. Verify with the checklist below.
- **One process only.** If Passenger starts several processes for the app,
  clients and publish requests are split between them: subscribers on
  process A never receive events published to process B, and per-process
  replay protection is weakened. `GET /healthz` returns a random
  `instanceId` per process; call it repeatedly — **if you see more than one
  id, the deployment is not supported.** Ask the host to set the app's
  maximum instances to 1.
- **Idle shutdown.** Passenger may stop an app with no traffic and start it
  on the next request. Connected sockets keep it busy, but after idle periods
  the first client connection will be slower and in-memory state starts empty
  (harmless: clients resubscribe).
- **Forced timeouts.** Some proxies cut connections after a fixed time
  (e.g. 60–300 s) regardless of traffic. The SDK reconnects automatically,
  but frequent drops mean missed events. Server pings every
  `DS_HEARTBEAT_INTERVAL_MS` (default 30 s) keep connections active for most
  idle-timeout proxies.

## 8. Subdomain, DNS and TLS (WSS)

1. *Domains* → create `ws.example.com` (document root can be any empty folder).
2. DNS: an `A`/`AAAA` record for `ws` pointing to the hosting server (cPanel
   creates it automatically if the zone is hosted there).
3. *SSL/TLS Status* → run AutoSSL for `ws.example.com`.
4. Point the Node.js app's *Application URL* to `ws.example.com`.

TLS is terminated by the host's web server; the browser uses
`wss://ws.example.com/ws`. Do not try to configure certificates inside
DynamicSocket.

Set `allowedOrigins` in `apps.json` to the exact origins of your Laravel
sites (`https://shop.example.com`).

About `DS_TRUSTED_PROXIES`: behind Passenger the TCP peer is the web server.
Only set this if you know the proxy's address *and* that it overwrites
`X-Forwarded-For`. If unsure, leave it empty: all clients will then appear to
come from the proxy address, so raise `DS_MAX_CONNECTIONS_PER_IP` and
`DS_UPGRADES_PER_IP_PER_MIN` accordingly (they effectively become global
limits).

## 9. Health checks

```bash
curl -s https://ws.example.com/healthz
curl -s https://ws.example.com/readyz
```

## 10. Restart behaviour

Restart from *Setup Node.js App → Restart*, or `touch tmp/restart.txt` in the
application root (Passenger convention). A restart drops all connections;
clients reconnect and resubscribe; messages published during the restart are
lost (see API.md §1). Restart after every change to `apps.json` or environment
variables — configuration is read only at startup.

## 11. Logs

DynamicSocket writes JSON lines to stdout. Under Passenger, stdout usually
goes to the app's log (often `~/dynamicsocket/stderr.log`, or the location
shown in *Setup Node.js App*; some hosts expose it only in the Apache error
log). Startup configuration errors are printed to stderr and the process exits
with code 78.

## 12. Resource limits

Shared accounts commonly limit memory (e.g. 512 MB–1 GB), processes and open
files (`ulimit -n`). Each WebSocket uses one file descriptor. Measured on a
development machine (see [LOADTEST.md](LOADTEST.md)), ~1000 idle-ish clients
used ~81 MB RSS; your numbers will differ. Set `DS_MAX_CONNECTIONS` below what
the account can hold.

## 13. Verification checklist

Run all of these from your workstation after deploying:

```bash
# 1. HTTP reaches the app
curl -i https://ws.example.com/healthz

# 2. Single instance: all ids must be identical
for i in $(seq 1 20); do curl -s https://ws.example.com/healthz; echo; done | sort | uniq -c

# 3. WebSocket upgrade works through the host's web server (expect "101 Switching Protocols")
curl -i --http1.1 -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://shop.example.com" \
  "https://ws.example.com/ws?app=shop" --max-time 5

# 4. End-to-end: issue a token and publish (run where the config/secret exists)
npm run token:issue -- --app shop --sub 1 --channels orders
npm run publish:signed -- --url https://ws.example.com --app shop --channel orders --event test.ping
```

A `101` in step 3 followed by a `{"type":"hello",…}` frame proves upgrades
work. A `200`/`404`/`400` HTML page, or a hang, means the host is not
forwarding WebSocket upgrades. Then leave a browser tab connected for 30+
minutes and check (with `disconnected` events in the console) that the host
does not cut connections.

## 14. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Step 3 returns `200` with HTML, or `502/503` | Web server/Passenger not forwarding Upgrade; ask the host or move to a VPS |
| Browser console: `WebSocket connection failed`, close `1006` | Upgrade rejected: wrong path, Origin not in `allowedOrigins` (403), app id wrong, or proxy issue |
| Events sometimes missing | More than one process (`instanceId` differs), or reconnect gaps |
| Connections drop every N seconds | Host proxy timeout; heartbeat reduces but cannot override hard limits |
| App does not start, exit code 78 | Configuration error; read the log |
| `Error [ERR_REQUIRE_ESM]` | Startup file set to `src/server.js`; use `app.cjs` |

See also [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## If your host fails these checks

The alternatives that need no third-party WebSocket service:

- A small VPS (1 vCPU / 1 GB is enough to start) following
  [DEPLOYMENT.md](DEPLOYMENT.md). Laravel can stay on the cPanel host and
  publish to the VPS over HTTPS.
- The Docker image on any container host that supports long-lived
  connections.
