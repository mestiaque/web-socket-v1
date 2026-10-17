# DynamicSocket

A self-hosted WebSocket server that gives multiple applications (Laravel or
anything that can sign an HTTP request) real-time delivery to browsers:
notifications, chat, live dashboards, order/payment status, inventory and any
other application-defined event — without a hosted WebSocket provider and
without a server-side class per event.

- **Node.js + [`ws`](https://github.com/websockets/ws)**, one runtime dependency.
- **Multi-application**: separate credentials, origins, limits and channel
  namespaces per app; nothing crosses between apps.
- **Short-lived, single-use signed client tokens** issued by your backend;
  channel permissions travel inside the token.
- **Dynamic channels and events**: any channel/event name matching the
  documented character set; no server changes.
- **HMAC-signed publish API** with timestamp window, nonce replay protection,
  body limits and per-app rate limits.
- **Operational hardening**: origin allowlist, connection/IP/app limits,
  heartbeat, auth timeout, backpressure, structured redacted logs, Prometheus
  metrics, graceful shutdown.
- **Online/offline presence**: member lists per presence channel, join/leave
  events, multi-tab merging, reload-flicker suppression, and a backend query API.
- **JavaScript SDK** with reconnect (exponential backoff + jitter),
  subscription restoration, heartbeat and duplicate-listener prevention.

> **Delivery is best-effort and in-memory.** A `200` from the publish API
> means DynamicSocket handed the message to every socket subscribed *at that
> moment*. Disconnected clients miss messages; a restart drops all state.
> See [docs/API.md §1](docs/API.md#1-delivery-semantics).

## Quick start

Requires Node.js ≥ 20.12 (22/24 LTS recommended).

```bash
npm ci
cp .env.example .env
cp apps.example.json apps.json
npm run app:generate -- --id shop --key k1 --origin http://localhost:8080
# put the printed DS_SHOP_SECRET_K1=... into .env, and make apps.json contain
# only the "shop" app with keys [{"id":"k1","secretEnv":"DS_SHOP_SECRET_K1"}]
npm start
curl localhost:6001/healthz
```

Browser demo (development only; stands in for your backend):

```bash
node examples/browser/dev-backend.js --app shop --port 8080
# open http://localhost:8080, click "Publish via backend"
```

From the command line:

```bash
npm run publish:signed -- --app shop --channel demo.orders --event order.created --data '{"order_id":1001}'
```

## How it fits together

```
Browser ──(1) POST /dynamicsocket/token──► Laravel  (authenticates user, signs token
   │                                          │       with channel grants)
   └──(2) wss://ws.example.com/ws?app=shop    │
          {"type":"auth","token":"…"}         │
          {"type":"subscribe","channel":"orders"}
                          ▲                   │
                          │      (3) POST /v1/publish  (HMAC-signed)
                     DynamicSocket ◄──────────┘
```

Browser receives:

```json
{"type":"event","id":"…","target":"channel","channel":"orders","event":"order.created",
 "data":{"order_id":1001,"status":"pending"},"sentAt":"2026-10-16T17:41:57.479Z"}
```

## Documentation

| Document | Contents |
|---|---|
| [docs/API.md](docs/API.md) | WebSocket protocol, token format, signed HTTP API, error/close codes, limits, delivery semantics |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, state, design decisions, scaling and reliable-delivery design |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls and their tests, revocation, key rotation, residual risks |
| [docs/LARAVEL.md](docs/LARAVEL.md) | Token issuing, permissions, publishing, after-commit queue jobs, logout |
| [docs/SDK.md](docs/SDK.md) | JavaScript SDK reference |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local development, Docker, VPS (systemd + nginx + TLS) |
| [docs/CPANEL.md](docs/CPANEL.md) | cPanel deployment — what must be verified and how |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms → causes |
| [docs/LOADTEST.md](docs/LOADTEST.md) | Load-test plan and measured results |
| [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | Release and deployment checklist |

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Start the server (`src/server.js`; loads `.env` if present) |
| `npm run dev` | Start with `--watch` |
| `npm test` | All tests (unit, integration, security) |
| `npm run test:unit` / `test:integration` / `test:security` | Individual suites |
| `npm run test:e2e:setup -- <dir>` then `npm run test:e2e -- <dir>` | Laravel + Chrome end-to-end test |
| `npm run test:docker` | Docker image + compose smoke test |
| `npm run lint` | ESLint |
| `npm run app:generate -- --id <app> --key <kid> --origin <url>` | New secret + apps.json entry |
| `npm run token:issue -- --app <app> --sub <user> --channels a,b.*` | Dev: mint a client token |
| `npm run publish:signed -- --app <app> --channel <c> --event <e> --data '<json>'` | Dev: signed publish |
| `npm run loadtest -- --app <app> --clients 1000 --rate 100` | Load test (see docs/LOADTEST.md) |

## Project layout

```
src/            server (config, auth, channels, messaging, security, websocket, http, adapters, observability)
sdk/            browser/Node client SDK (no dependencies, no secrets)
examples/       browser demo, Laravel integration
tests/          unit/, integration/, security/ (node:test)
docs/           documentation
deploy/         systemd unit, nginx config
scripts/        app/secret generator, token/publish dev tools, load test
app.cjs         CommonJS entry for Passenger/cPanel
```

## Status

Version 0.2.0.

**Implemented and covered by automated tests:** token auth (expiry, reuse,
tampering, alg confusion, app mismatch), auth timeout, explicit channel
authorization, public channels, user-targeted delivery, unsubscribe, app
isolation, disconnect cleanup, server heartbeat, session expiry, signed
publish/disconnect API, nonce replay rejection, timestamp window, payload
limits, per-connection/per-app/per-IP rate limits, connection limits, origin
policy, trusted-proxy handling, slow-consumer backpressure, invalid frames,
log redaction, graceful shutdown, SDK reconnect/restore/heartbeat/backoff,
presence (join/leave, multi-tab, grace period, limits, query API), and
PHP↔Node token/signature compatibility (`npm test`, 114 tests).

**End-to-end verified** (`npm run test:e2e`): a fresh Laravel 13 app using the
example files, its queue worker, real DynamicSocket and headless Google
Chrome — login, token, connect, online list, after-commit queued publish,
reload without flicker, logout disconnect. See docs/LARAVEL.md.

**Not implemented:** message persistence/history,
acknowledgements, multi-instance adapters (Redis), hot config reload,
per-token revocation lists. Interfaces and designs for these are in
docs/ARCHITECTURE.md.

**Docker verified** (`npm run test:docker`): build, healthcheck, non-root,
WebSocket round trip, graceful stop, compose. See docs/DEPLOYMENT.md.

**Not verified in this repository:** browsers other than Chrome, any cPanel
host (must be checked on your host with docs/CPANEL.md §13).

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
