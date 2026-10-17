# Architecture

## Overview

```
 Browser (SDK)                         Laravel / any backend
     │  1. POST /dynamicsocket/token  ───────►│ (session or Sanctum auth)
     │◄─────────── short-lived token ─────────│ signs with app secret
     │                                         │
     │  2. wss://ws.example.com/ws?app=shop    │  4. POST /v1/publish (HMAC-signed)
     ▼                                         ▼
 ┌──────────────────────────── DynamicSocket (one Node.js process) ───────────────────────────┐
 │ http/router ── health, readyz, metrics, publish, disconnect                                │
 │      │                     │                                                               │
 │ websocket/handshake        http/signed-request ── auth/request-signature                   │
 │  (path, app, origin,        (size limit, HMAC, timestamp, security/replay-protection,      │
 │   limits, rate)              rate limit)                                                   │
 │      │                                    │                                                │
 │ websocket/connection ── auth/client-token │ messaging/event-validator                      │
 │  (auth, subscribe, ping,  channels/       ▼                                                │
 │   rate limit, timers)     channel-manager adapters/in-memory-bus ──► messaging/broadcaster │
 │      │                       │                                          │ (backpressure)  │
 │      └──────────► channels/subscription-registry ◄──────────────────────┘                  │
 │ websocket/heartbeat    observability/logger, metrics                                       │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. The browser asks its own backend for a token. The backend authenticates the
   user with whatever guard it uses and decides which channels the user may
   join.
2. The SDK connects to DynamicSocket, receives `hello`, and sends the token.
3. The client subscribes; DynamicSocket checks the token's channel grants and
   the app's public channel patterns.
4. The backend publishes with a signed HTTP request. DynamicSocket validates
   it and hands it to the message bus; the broadcaster writes one serialized
   frame to every matching local socket.

DynamicSocket never calls out to other services (no webhooks, no outbound
HTTP), so it has no SSRF surface.

## Module responsibilities

| Path | Responsibility |
|---|---|
| `src/server.js` | Process entry: `.env` loading, config, signals, exit codes |
| `app.cjs` | CommonJS shim for loaders that `require()` the startup file (Passenger) |
| `src/dynamicsocket.js` | Composition root; `start()` / graceful `stop()` |
| `src/config/` | Environment parsing and validation (all problems reported at once) |
| `src/auth/app-registry.js` | Apps and their key sets |
| `src/auth/client-token.js` | Token creation/verification (HS256, constant-time) |
| `src/auth/request-signature.js` | Canonical string, HMAC signing/verification |
| `src/auth/origin-policy.js` | Origin allowlist policy |
| `src/channels/` | Name rules, authorization policy, registries, subscribe/unsubscribe/cleanup, presence (`presence-manager.js`) |
| `src/messaging/` | Publish validation, serialization, local fan-out with backpressure |
| `src/adapters/` | Message bus contract and the in-memory implementation |
| `src/security/` | Token buckets, bounded replay store, body size limits |
| `src/websocket/` | Upgrade checks, connection state machine, heartbeat, protocol constants |
| `src/http/` | Router and endpoint handlers |
| `src/observability/` | Redacting JSON logger, Prometheus metrics |
| `sdk/dynamicsocket.js` | Dependency-free browser/Node client |

## State

All state is in process memory:

| State | Structure | Bounded by |
|---|---|---|
| Connections | `ConnectionTracker` (Set + per-app/per-IP counts) | `DS_MAX_CONNECTIONS`, per-app, per-IP limits |
| Subscriptions | `Map<appId\0channel, Set<conn>>` | connections × `DS_MAX_SUBSCRIPTIONS_PER_CONNECTION` |
| Users | `Map<appId\0sub, Set<conn>>` | connections |
| Presence members | `Map<appId\0channel, Map<sub, {info, conns, leaveTimer}>>` | `DS_PRESENCE_MAX_MEMBERS` per channel |
| Request nonces | `ExpiringKeyStore` | `DS_NONCE_STORE_MAX` (fails closed) |
| Token jti | `ExpiringKeyStore` | `DS_NONCE_STORE_MAX` (fails closed) |
| Rate limiter buckets | `KeyedRateLimiter` | 100 000 keys each, idle buckets swept every 30 s |

**Everything is lost on restart.** Clients reconnect (the SDK does it
automatically with fresh tokens and restores subscriptions); messages
published while they were disconnected are not replayed. Nonce/jti memory is
also lost, which is safe only because restarts take longer than zero seconds
and nonces are bound to a ±5 min timestamp window — see SECURITY.md for the
residual risk.

## Key design decisions

- **`ws` with `noServer: true`.** Upgrade requests are vetted (path, app,
  Origin, limits, rate) before `ws` allocates anything.
- **Compression disabled.** `permessage-deflate` keeps zlib state per
  connection (memory), adds CPU per frame, and has a history of
  resource-exhaustion bugs; envelopes are small JSON. Re-evaluate only with
  measurements.
- **App id in the URL, token in the first message.** The app id is not secret
  and lets the Origin policy run before the handshake; tokens stay out of
  access logs.
- **Explicit channel authorization.** Grants travel in the signed token,
  computed by the backend from real permissions. No name-based conventions.
- **Single-use, short-lived tokens + bounded sessions** instead of a
  revocation list: see SECURITY.md.
- **Serialize once per channel.** Each publish creates one Buffer per target
  channel and writes it to every subscriber.
- **Slow consumers are disconnected** rather than buffered without bound.
- **Fail closed** when the replay store is full.

## Scaling beyond one process

The single-process model is a hard requirement of 0.1: running two processes
behind a load balancer would split subscribers between processes and the
publish API would reach only one of them. Also, nonce/jti replay protection
would no longer be global.

The seams for horizontal scaling are already in place:

| Concern | 0.1 | Multi-instance design |
|---|---|---|
| Fan-out | `InMemoryBus` delivers locally | `RedisBus` implementing `adapters/message-bus.js`: `publish()` → `PUBLISH ds:<appId> <json>`; every instance `SUBSCRIBE`s and calls its local `Broadcaster`. `delivery.scope` becomes `"bus"`. |
| Replay protection | `ExpiringKeyStore` | Same interface backed by `SET key 1 NX PXAT <expiresAt>` (atomic). |
| Rate limits | per process | Either accept per-instance limits (÷ N) or a Redis token bucket (Lua script). |
| Connection limits | per process | Per instance; global limits via a shared counter if needed. |
| User disconnect | local registry | Broadcast a control message on the bus. |
| Presence | `PresenceManager`, per process | Redis hash per channel (`sub` → refcount/info) updated atomically by every instance, with TTL-refreshed instance leases so a crashed instance's members expire; join/leave events published on the bus. |

Redis Pub/Sub is itself at-most-once; it does not add durability.

## Future: reliable delivery

Not implemented. A future version could offer opt-in reliable channels:

- **Message identity:** backend-supplied `id` (already supported), unique per
  app; plus a per-channel monotonically increasing `seq` assigned by the
  store.
- **Durable history:** append each message to a per-channel log (Redis
  Streams `XADD` with `MAXLEN`, or a database table) before fan-out.
- **Resume:** the client sends `{"type":"subscribe","channel":"orders","since":<seq>}`;
  the server replays from the log, then switches to live delivery.
- **Acknowledgements:** optional `{"type":"ack","id":...}` from clients for
  "received by the browser"; "acknowledged by the application" stays an
  application concern.
- **Retries:** server-side redelivery only to connected clients that have not
  acked within a timeout, bounded by attempts; clients de-duplicate by `id`.
- **Ordering:** per-channel order by `seq`; no cross-channel ordering.
- **Transactional outbox (backend side):** write the event row in the same DB
  transaction as the business change; a worker publishes outbox rows and marks
  them sent. This turns "lost if the publish request fails" into
  "at-least-once from Laravel to DynamicSocket". The `afterCommit()` queued job
  in the Laravel example is a lighter version that avoids publishing rolled-back
  changes but can still lose a message if the queue itself loses the job.

## Presence channels (0.2)

`src/channels/presence-manager.js`. A channel is a presence channel when it
matches the app's `presenceChannels` patterns. Members are keyed by `sub`
(tabs/devices merged) and carry the token's signed `user` claim as `info`.
`ChannelManager` calls `join`/`leave` on subscribe, unsubscribe and
connection cleanup; `member_added`/`member_removed` frames go through the
`Broadcaster` (same backpressure rules) to every subscriber except the
member's own connections. A per-member leave timer
(`DS_PRESENCE_LEAVE_GRACE_MS`) suppresses reload flicker. Protocol in
API.md §2.8.
