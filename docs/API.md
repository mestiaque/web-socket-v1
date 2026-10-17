# DynamicSocket protocol and API reference

This document is the contract between DynamicSocket, browser clients and
application backends. Version: `0.2.0`.

- [1. Delivery semantics](#1-delivery-semantics)
- [2. WebSocket protocol](#2-websocket-protocol)
  - [2.8 Presence (online/offline)](#28-presence-onlineoffline)
- [3. Client tokens](#3-client-tokens)
- [4. Signed HTTP requests](#4-signed-http-requests)
- [5. HTTP endpoints](#5-http-endpoints)
- [6. Error codes](#6-error-codes)
- [7. Limits](#7-limits)

---

## 1. Delivery semantics

DynamicSocket 0.1 is a **best-effort, at-most-once, in-memory** relay.

| Stage | Meaning | Who knows |
|---|---|---|
| Request accepted | `POST /v1/publish` returned `200`: signature, nonce, rate limit and body validation passed. | Backend (HTTP response) |
| Message queued | **Not applicable in 0.1.** There is no queue. The in-memory bus delivers synchronously during the request. | — |
| Sent to an active socket | The frame was handed to `ws.send()` for a socket that was subscribed *at that moment* and under its buffer limit. Counted in `delivery.sent`. | Backend (`delivery` object) |
| Received by the browser | The browser's WebSocket fired `message`. DynamicSocket cannot observe this. | Browser only |
| Acknowledged by the application | Application code processed it. Not implemented; would require a client→server ack message. | — |

Consequences:

- Messages published while a user is disconnected or not yet subscribed are **lost**.
- A process restart drops all connections and subscriptions; clients reconnect
  and resubscribe, but messages published during the gap are lost.
- `delivery.sent` > 0 does **not** guarantee receipt (the TCP connection may
  die after the send). `delivery.dropped` counts sockets that were matched but
  not sent to (closing, or over the buffer limit).
- Ordering: frames sent to one socket are delivered in send order (TCP).
  Across different publish requests, order is the order in which DynamicSocket
  processed the requests, which is not necessarily the order Laravel sent them
  if they were in flight concurrently.
- If a backend retries a publish (e.g. a queued job after a timeout), clients
  may receive the same message twice. Supply a stable `id` and de-duplicate on
  the client.

Use the realtime channel as a *notification* path. The database (or an API
call made after reconnecting) remains the source of truth. See
[ARCHITECTURE.md](ARCHITECTURE.md#future-reliable-delivery) for the design of a
future reliable-delivery mode.

---

## 2. WebSocket protocol

### 2.1 Connecting

```
wss://<host><DS_WS_PATH>?app=<appId>
```

Default path: `/ws`. The `app` query parameter is required so the Origin can be
checked against that application's allowlist before the upgrade completes.
**The token is never put in the URL** (URLs end up in proxy and access logs).

Handshake rejections are plain HTTP responses, so browsers only see a failed
connection (close code `1006`):

| Status | Reason |
|---|---|
| 400 | `app` parameter missing |
| 403 | Unknown app, or Origin not allowed (same response for both) |
| 404 | Wrong path |
| 429 | Too many upgrade attempts or too many open connections from this IP |
| 503 | Global or per-app connection limit reached, or server shutting down |

### 2.2 Message envelope

All frames are UTF-8 JSON text frames. Every message has a string `type`.
Binary frames are refused. Client messages may include an optional `ref`
(string ≤ 64 chars or integer) that is echoed in the direct reply.

### 2.3 Client → server (control messages only)

Clients **cannot publish** application events.

| type | Fields | Allowed before auth | Reply |
|---|---|---|---|
| `auth` | `token` (string) | yes (once) | `auth_ok`, or `error` then close `4001` |
| `subscribe` | `channel` (string) | no | `subscribed` or `error` |
| `unsubscribe` | `channel` (string) | no | `unsubscribed` (also when not subscribed) |
| `ping` | — | yes | `pong` |

```json
{ "type": "auth", "token": "<short-lived-token>" }
{ "type": "subscribe", "channel": "orders", "ref": 1 }
{ "type": "unsubscribe", "channel": "orders" }
{ "type": "ping" }
```

### 2.4 Server → client

```json
{ "type": "hello", "connectionId": "Rqf7gDw5IsHVzuHA", "authTimeoutMs": 10000 }
{ "type": "auth_ok", "connectionId": "Rqf7gDw5IsHVzuHA", "appId": "shop", "sub": "42", "sessionExpiresAt": "2026-10-16T18:41:56.903Z" }
{ "type": "subscribed", "channel": "orders", "ref": 1 }
{ "type": "unsubscribed", "channel": "orders" }
{ "type": "pong" }
{ "type": "error", "code": "forbidden", "message": "Not authorized for this channel", "channel": "secret", "ref": 2 }
```

Application event:

```json
{
  "type": "event",
  "id": "d53740c0-7a89-46e5-9192-19a18937a758",
  "target": "channel",
  "channel": "orders",
  "event": "order.created",
  "data": { "order_id": 1001, "status": "pending" },
  "sentAt": "2026-10-16T17:41:57.479Z"
}
```

- `target` is `"channel"` (channel broadcast) or `"user"` (user-targeted
  delivery, `channel` is `null`).
- `id` is the same for every copy of one publish. A publish that targets two
  channels the client is subscribed to, or a channel and the user, produces
  separate frames with the same `id`.
- `sentAt` is the time DynamicSocket accepted the publish (server clock).
- `data` is any JSON value supplied by the backend, passed through unchanged.

### 2.5 Connection lifecycle

1. Client connects; server sends `hello`.
2. Client must send a valid `auth` within `DS_AUTH_TIMEOUT_MS` (default 10 s),
   otherwise `error: auth_timeout` and close `4002`.
3. After `auth_ok`, the client subscribes to channels.
4. The server pings every `DS_HEARTBEAT_INTERVAL_MS` (default 30 s). A peer
   that has not answered the previous ping (and sent nothing else) is
   terminated. Browsers answer pings automatically; they cannot see them, so
   the SDK additionally sends `ping` messages to detect dead servers.
5. After `DS_MAX_SESSION_SECONDS` (default 3600) the server closes with `4000`;
   the client reconnects with a fresh token. This bounds how long permissions
   embedded in a token stay in effect.

### 2.6 Close codes

| Code | Meaning | SDK reconnects? |
|---|---|---|
| 1000 | Normal closure | no (client initiated) |
| 1001 | Server shutting down | yes |
| 1002 | Protocol error (invalid frame; detected by `ws`) | yes |
| 1006 | Abnormal closure (network, handshake rejected, heartbeat terminated) | yes |
| 1009 | Message larger than `DS_MAX_PAYLOAD_BYTES` | yes |
| 4000 | Session expired; reconnect with a new token | yes, immediately |
| 4001 | Authentication failed (`auth_failed`, `token_expired`, `token_reused`) | yes with a token function, up to `maxAuthFailures`; no with a static token |
| 4002 | Authentication timeout | as 4001 |
| 4009 | Slow consumer: outbound buffer exceeded `DS_MAX_BUFFERED_BYTES` | yes |
| 4010 | Disconnected by the application (`POST /v1/disconnect`) | no (configurable) |
| 4029 | Inbound rate limit repeatedly exceeded, or auth brute-force throttle | yes, with backoff |

### 2.7 Channels

- Name: 1–128 characters from `A-Z a-z 0-9 _ - = @ , . ; :`.
- Names are opaque and **namespaced per application**: `orders` in app A and
  `orders` in app B are unrelated.
- A name prefix such as `private-` has **no meaning**. Access is decided by:
  1. the app's `publicChannels` patterns (any authenticated connection of that
     app), or
  2. the token's `channels` patterns (granted to this user by the backend).
- Pattern syntax: an exact name, or a prefix followed by `*`
  (`chat.room.*` matches `chat.room.7`). A lone `*` matches every channel of
  the app; avoid it.

### 2.8 Presence (online/offline)

A channel is a **presence channel** when it matches one of the app's
`presenceChannels` patterns (apps file). Names do not matter. Who may join is
decided by the normal rules in §2.7 (public pattern or token grant).

Members are users (`sub`), not connections: a user with three tabs open is one
member. Each member has `id` (the `sub`) and `info` (the token's optional
`user` claim, e.g. `{"name":"Alice"}`, or `null`).

Subscribing returns the current members, including yourself:

```json
{ "type": "subscribed", "channel": "online",
  "presence": { "count": 2, "members": [ { "id": "1", "info": { "name": "Alice" } },
                                         { "id": "2", "info": { "name": "Bob" } } ] } }
```

Other subscribers then receive changes (never about their own user):

```json
{ "type": "presence", "action": "member_added",   "channel": "online", "member": { "id": "3", "info": { "name": "Carol" } } }
{ "type": "presence", "action": "member_removed", "channel": "online", "member": { "id": "3" } }
```

- `member_added` is sent when a user's **first** connection joins.
- `member_removed` is sent when the user's **last** connection leaves
  (unsubscribe, close, heartbeat timeout, logout disconnect) and has not
  rejoined within `DS_PRESENCE_LEAVE_GRACE_MS` (default 3000 ms). This hides
  page reloads and short network blips. During the grace period the user is
  still listed.
- At most `DS_PRESENCE_MAX_MEMBERS` (default 1000) distinct users per presence
  channel; further users get `error` `presence_full` (existing members may open
  more tabs). For very large audiences, use smaller presence channels (per
  team/room) and query individual users with `POST /v1/presence`.
- Every member's `info` is visible to every other member. Put only public
  profile data in the `user` claim.
- Presence is in-memory and per process, like all state (see §1). After a
  restart, members appear again as clients reconnect.

---

## 3. Client tokens

Tokens use the JWT compact serialization with **HS256 only**:

```
base64url(header) . base64url(claims) . base64url(HMAC-SHA256(secret, base64url(header) "." base64url(claims)))
```

Header:

```json
{ "alg": "HS256", "typ": "JWT", "kid": "k1" }
```

Claims:

| Claim | Type | Rule |
|---|---|---|
| `appId` | string | Must equal the `?app=` of the connection |
| `sub` | string (or non-negative integer, normalized to string) | 1–191 chars; the user id |
| `iat` | integer, seconds | Not more than `DS_TOKEN_CLOCK_SKEW_SECONDS` in the future |
| `exp` | integer, seconds | `> iat`; `exp - iat ≤ DS_TOKEN_MAX_TTL_SECONDS` (default 900); rejected once `now > exp + skew` |
| `jti` | string | 8–128 chars `[A-Za-z0-9_.:-]`; single-use when `DS_TOKEN_SINGLE_USE=true` (default) |
| `channels` | string[] | ≤ 100 channel patterns this user may subscribe to (may be empty) |
| `user` | object (optional) | Public profile shown to presence-channel members (`info`). JSON object, ≤ 1 KiB. |

Additional claims are ignored. Tokens with `alg` other than `HS256` (including
`none`) are rejected. Recommended lifetime: 60–300 seconds. The token only
needs to be valid at the moment of `auth`; the connection then lives until it
closes or `DS_MAX_SESSION_SECONDS` elapses.

Reference implementations: `src/auth/client-token.js` (Node) and
`examples/laravel/app/Support/DynamicSocket/Signer.php` (PHP). The automated
test `tests/integration/laravel-contract.test.js` checks they agree.

---

## 4. Signed HTTP requests

Every `/v1/*` request (`publish`, `disconnect`, `presence`) must carry:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-DS-App` | Application id |
| `X-DS-Key` | Key id |
| `X-DS-Timestamp` | Unix time in seconds |
| `X-DS-Nonce` | 16–128 chars `[A-Za-z0-9_-]`, unique per request |
| `X-DS-Signature` | Lowercase hex HMAC-SHA256 of the canonical string |

Canonical string — eight fields joined with `\n` (no trailing newline):

```
DS1-HMAC-SHA256
POST
/v1/publish
shop
k1
1792345678
Zx8d2C0d0mV8a1tq2XzvP9Ld
3b5d1c...<lowercase hex SHA-256 of the exact body bytes>
```

1. Scheme literal `DS1-HMAC-SHA256`
2. HTTP method, uppercase
3. Request path **including the query string exactly as sent** (normally `/v1/publish`)
4. App id
5. Key id
6. Timestamp (same string as the header)
7. Nonce
8. SHA-256 of the raw body bytes, lowercase hex

Server checks, in order: per-IP failure throttle → content type → body size →
app/key/HMAC (constant-time) → timestamp within ±`DS_SIGNATURE_TOLERANCE_SECONDS`
(default 300) → nonce not seen before for this app → app publish rate limit →
JSON parse → body validation.

Nonces are remembered for the tolerance window. The registry is in-memory and
bounded (`DS_NONCE_STORE_MAX`); when full of unexpired nonces it **fails
closed** with `503 capacity_exceeded` rather than forgetting nonces.

---

## 5. HTTP endpoints

### `POST /v1/publish` (signed)

```json
{
  "channels": ["orders", "user.42"],
  "users": ["42"],
  "event": "order.created",
  "data": { "order_id": 1001, "status": "pending" },
  "id": "order.1001.created"
}
```

| Field | Required | Rule |
|---|---|---|
| `channel` / `channels` | one of `channel(s)` or `users` | A channel name, or an array of them. Not both `channel` and `channels`. |
| `users` | | Array of user ids (strings or non-negative integers). Delivered to every connection authenticated as that `sub` in this app, regardless of subscriptions. |
| `event` | yes | 1–128 chars `[A-Za-z0-9_\-.:/\\@]`. Any name works; no server changes needed. |
| `data` | no | Any JSON value. Defaults to `null`. |
| `id` | no | 1–128 chars `[A-Za-z0-9_.:-]`. Generated (UUID) when omitted. Use a stable id for de-duplication. |

Unknown fields are rejected. At most `DS_MAX_PUBLISH_TARGETS` (default 100)
channels + users per request.

Response `200`:

```json
{
  "ok": true,
  "id": "order.1001.created",
  "acceptedAt": "2026-10-16T17:41:57.479Z",
  "delivery": { "scope": "local", "recipients": 2, "sent": 2, "dropped": 0 }
}
```

`scope: "local"` means the counts are exact for this single process. A future
shared-bus adapter would report `scope: "bus"` without per-socket counts.

### `POST /v1/disconnect` (signed)

```json
{ "users": ["42"] }
```

Closes every connection of those users in the calling app with close code
`4010`. Response: `{ "ok": true, "closed": 1 }`.

### `POST /v1/presence` (signed)

Online state as seen by DynamicSocket. Either or both fields:

```json
{ "users": ["42", "43"], "channel": "online" }
```

Response:

```json
{
  "ok": true,
  "users": { "42": true, "43": false },
  "channel": { "name": "online", "presence": true, "subscriptions": 3, "count": 2,
               "members": [ { "id": "42", "info": { "name": "Alice" } }, { "id": "44", "info": null } ] }
}
```

- A user is `true` while they have at least one open, authenticated
  connection to this app (presence-channel membership not required).
- For a non-presence channel, `channel` contains only `name`, `presence:
  false` and `subscriptions`.
- At most `DS_PRESENCE_MAX_MEMBERS` user ids per request.

### `GET /healthz`

Liveness. `{"status":"ok","instanceId":"0860970f42c0","uptimeSeconds":12}`.
`instanceId` is random per process.

### `GET /readyz`

`200 {"status":"ready"}` or `503 {"status":"shutting_down"}`.

### `GET /metrics`

Prometheus text format. Returns `404` unless `DS_METRICS_TOKEN` is set; then
requires `Authorization: Bearer <DS_METRICS_TOKEN>`.

### Error responses

```json
{ "ok": false, "error": { "code": "invalid_signature", "message": "Invalid request signature" } }
```

`429` and some `503` responses include `Retry-After` (seconds).

---

## 6. Error codes

| Code | Where | HTTP | Meaning |
|---|---|---|---|
| `bad_json` | WS, HTTP | 400 | Not valid JSON |
| `bad_message` | WS, HTTP | 422 | Wrong shape, unknown field, binary frame |
| `unknown_type` | WS | | Unknown client message type |
| `not_authenticated` | WS | | Subscribe/unsubscribe before `auth_ok` |
| `already_authenticated` | WS | | Second `auth` |
| `auth_failed` | WS | | Invalid token (generic on purpose) |
| `auth_timeout` | WS | | No auth within the timeout |
| `token_expired` | WS | | Token expired, or session expired |
| `token_reused` | WS | | Single-use token presented twice |
| `forbidden` | WS | | Channel not permitted; or disconnected by the app |
| `invalid_channel` | WS, HTTP | 422 | Channel name fails validation |
| `invalid_event` | HTTP | 422 | Event name fails validation |
| `subscription_limit` | WS | | Too many subscriptions on this connection |
| `presence_full` | WS | | Presence channel reached `DS_PRESENCE_MAX_MEMBERS` |
| `rate_limited` | WS, HTTP | 429 | Rate limit exceeded |
| `payload_too_large` | HTTP | 413 | Body over `DS_MAX_PUBLISH_BODY_BYTES` |
| `unsupported_media_type` | HTTP | 415 | Content-Type is not `application/json` |
| `invalid_signature` | HTTP | 401 | Missing/invalid signature headers, unknown app or key |
| `stale_request` | HTTP | 401 | Timestamp outside the tolerance window |
| `replayed_request` | HTTP | 409 | Nonce already used |
| `capacity_exceeded` | WS, HTTP | 503 | Replay store full; retry later |
| `not_found`, `method_not_allowed` | HTTP | 404, 405 | Routing |
| `internal_error` | WS, HTTP | 500 | Unexpected error (details only in server logs) |

---

## 7. Limits

| Variable | Default | Applies to |
|---|---|---|
| `DS_MAX_PAYLOAD_BYTES` | 16384 | Inbound WS message (close 1009) |
| `DS_MAX_PUBLISH_BODY_BYTES` | 65536 | HTTP body (413) |
| `DS_MAX_PUBLISH_TARGETS` | 100 | channels + users per request |
| `DS_MAX_SUBSCRIPTIONS_PER_CONNECTION` | 100 | |
| `DS_PRESENCE_MAX_MEMBERS` | 1000 | Distinct users per presence channel; also max ids per `/v1/presence` query |
| `DS_PRESENCE_LEAVE_GRACE_MS` | 3000 | Delay before `member_removed` |
| Token `user` claim | 1 KiB | |
| `DS_MAX_BUFFERED_BYTES` | 1048576 | Unsent bytes per socket before close 4009 |
| `DS_MAX_CONNECTIONS` | 10000 | Process-wide |
| `DS_MAX_CONNECTIONS_PER_IP` | 100 | |
| app `maxConnections` | `DS_MAX_CONNECTIONS` | Per application |
| `DS_CLIENT_RATE_PER_SEC` / `_BURST` | 10 / 20 | Inbound messages per connection |
| `DS_CLIENT_RATE_VIOLATIONS_BEFORE_CLOSE` | 5 | Then close 4029 |
| `DS_PUBLISH_RATE_PER_SEC` / `_BURST` | 100 / 200 | Per app (override with app `publishRate`) |
| `DS_UPGRADES_PER_IP_PER_MIN` | 120 | Handshake attempts |
| `DS_AUTH_FAILURES_PER_IP_PER_MIN` | 30 | Failed WS auths and failed HTTP signatures (separate counters) |
| Token size | 8192 chars | |
| Token `channels` | 100 entries | |

See `.env.example` for every variable.
