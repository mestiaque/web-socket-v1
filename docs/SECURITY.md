# Security guide

This document describes DynamicSocket's threat model, the controls that exist,
how they are tested, and the risks that remain. Each control lists the test
file that exercises it.

## Trust boundaries

| Party | Trusted with | Never trusted with |
|---|---|---|
| DynamicSocket operator | App secrets, configuration | — |
| Application backend (Laravel) | Its own app secret; deciding user identity and channel grants | Other apps' secrets |
| Browser / client | A short-lived token for one user | Secrets; publishing; choosing its own permissions |
| Network / proxies | Nothing, unless listed in `DS_TRUSTED_PROXIES` | Forwarded headers by default |

## Controls

### Authentication of WebSocket clients
- Every connection must authenticate with a backend-issued token within
  `DS_AUTH_TIMEOUT_MS` or it is closed (`4002`).
- Tokens: HS256 only (alg `none`/others rejected), constant-time signature
  comparison (`crypto.timingSafeEqual`), strict claim validation, maximum
  lifetime (`DS_TOKEN_MAX_TTL_SECONDS`, default 900 s), clock skew allowance
  (default 30 s), `appId` must match the connection's app.
- Tokens are **single-use** by default (`jti` remembered until expiry), so a
  token captured from a log or browser history cannot open a second socket.
- Error messages are generic (`auth_failed`) except `token_expired` and
  `token_reused`, which clients need to recover.
- Tests: `tests/unit/client-token.test.js`, `tests/integration/websocket.test.js`.

### Authorization and channel privacy
- Subscriptions are allowed only if the channel matches the app's
  `publicChannels` or the token's `channels`. Names carry no meaning;
  `private-x` is not private unless you leave it out of `publicChannels`
  and only grant it in tokens, and `orders` is not public unless listed.
- Clients cannot publish. The only client messages are `auth`, `subscribe`,
  `unsubscribe`, `ping`.
- Tests: `tests/unit/channels-messaging.test.js`, `tests/integration/websocket.test.js`,
  `tests/integration/sdk.test.js` (SDK refuses non-control messages).

### Presence (online/offline) data
- Presence is opt-in per channel pattern (`presenceChannels`) and still needs
  normal subscribe authorization, so only users allowed on the channel learn
  who else is on it.
- Member `info` comes only from the backend-signed token `user` claim (≤ 1 KiB
  object); clients cannot set or change it. It is shown to every member, so it
  must contain public data only. Browsers must render it as text, not HTML.
- `DS_PRESENCE_MAX_MEMBERS` bounds member lists (memory and message size).
- Presence events are never sent to the member's own connections and never
  cross applications.
- `POST /v1/presence` is signed like the other backend APIs.
- Tests: `tests/integration/presence.test.js`, `tests/unit/client-token.test.js`,
  and the browser end-to-end test.

### Cross-application isolation
- Separate keys per app; a key can only sign for its own app.
- Every registry key is `appId + NUL + name`; NUL cannot appear in validated
  names. Same channel or user id in two apps never collide.
- Token `appId` must equal the connection's `?app=`.
- Tests: `tests/security/isolation.test.js`.

### Origin policy (browser connections)
- Origin must exactly match an entry in the app's `allowedOrigins`.
  `"*"` disables the check for that app (not recommended).
- Missing Origin (non-browser clients) is refused unless the app sets
  `allowMissingOrigin: true`. Use a separate app id for server-side/native
  clients so browser apps keep a strict policy.
- **Origin is not authentication.** Non-browser clients can send any Origin.
  It only prevents *other websites* from using a victim's browser to open
  sockets. Tokens are still required.
- Tests: `tests/unit/security-primitives.test.js`, `tests/security/handshake.test.js`.

### Signed HTTP API (publish / disconnect)
- HMAC-SHA256 over a canonical string that covers method, path+query, app,
  key, timestamp, nonce and the SHA-256 of the exact body bytes.
- Timestamp window ±`DS_SIGNATURE_TOLERANCE_SECONDS` (default 300).
- Nonces are recorded after the signature verifies (unauthenticated traffic
  cannot fill the store) and rejected if reused (`409`). The store is bounded
  and fails closed (`503`) when full.
- Body size limit enforced while streaming (`413`), JSON only (`415`), strict
  schema (unknown fields rejected).
- Per-IP throttle on invalid signatures (`429`), per-app publish rate limit.
- There is **no unauthenticated publish endpoint**.
- Tests: `tests/unit/request-signature.test.js`, `tests/integration/http-api.test.js`,
  `tests/security/abuse.test.js` (nonce store capacity).

### Replay protection scope
The nonce and jti registries are in memory, per process.
- Single process (the supported model): replay is rejected within the window.
- **After a restart**, the registries are empty. A request captured within the
  last `DS_SIGNATURE_TOLERANCE_SECONDS` could be replayed once against the new
  process. Mitigations: use TLS for the publish API (captures require breaking
  TLS or compromising a host), keep the tolerance short (e.g. 60 s if clocks
  are NTP-synced), and make backend events idempotent (stable `id`).
- **Multiple processes** must use an atomic shared store (see
  ARCHITECTURE.md); running several processes with the in-memory store is not
  supported.

### Rate limiting and denial of service
| Vector | Control | Test |
|---|---|---|
| Connection flood | Global / per-app / per-IP connection limits; upgrades per IP per minute | `tests/security/handshake.test.js` |
| Idle unauthenticated sockets | Auth timeout | `tests/integration/websocket.test.js` |
| Message flood | Per-connection token bucket; close `4029` after repeated violations | `tests/security/abuse.test.js` |
| Large frames | `maxPayload` (close `1009`) enforced by `ws` before buffering the full message | `tests/security/abuse.test.js` |
| Invalid frames | Rejected by `ws` (e.g. unmasked client frame → `1002`) | `tests/security/abuse.test.js` |
| Malformed / hostile JSON | Parse errors return `bad_json`; payloads never executed or used as object keys | `tests/security/abuse.test.js` |
| Token brute force | Per-IP failed-auth throttle; HMAC-SHA256 keys are 256-bit | `tests/security/abuse.test.js` |
| Signature brute force | Per-IP failed-signature throttle | `tests/integration/http-api.test.js` |
| Slow readers (memory growth) | Per-socket buffer cap → close `4009`, terminate after grace | `tests/security/abuse.test.js`, unit test in `channels-messaging.test.js` |
| Subscription explosion | `DS_MAX_SUBSCRIPTIONS_PER_CONNECTION`, token channel cap | `tests/security/abuse.test.js` |
| Slowloris on HTTP | `headersTimeout`, `requestTimeout`, `keepAliveTimeout` | not automated (Node checks timeouts on a 30 s interval) |
| Compression bombs | `permessage-deflate` disabled | — |

Limits are per process and per IP. A distributed attack from many IPs can
still exhaust `DS_MAX_CONNECTIONS`; put DynamicSocket behind a proxy/CDN or
firewall that can rate-limit at the network edge for internet-facing
deployments.

### Forwarded headers
`X-Forwarded-For` is used **only** when the TCP peer is listed in
`DS_TRUSTED_PROXIES`. The header is walked right-to-left, skipping trusted
proxies; client-supplied left-most entries are ignored. Configure the proxy to
**overwrite** the header (`proxy_set_header X-Forwarded-For $remote_addr;`).
Test: `tests/security/handshake.test.js`, `tests/unit/security-primitives.test.js`.

### Logging and error output
- JSON logs with recursive redaction of keys matching
  `token|secret|password|signature|authorization|cookie|api_key|credential|private_key`;
  long strings truncated.
- Tokens, secrets and signatures are never logged by the code paths; redaction
  is a second line of defence.
- Clients receive only error codes and fixed messages; stack traces stay in
  server logs.
- Configuration errors never echo secret values or file contents.
- Tests: `tests/unit/logger.test.js`, `tests/security/redaction.test.js`,
  `tests/unit/config.test.js`, `tests/integration/http-api.test.js`.

### Secrets handling
- Secrets live in the apps file or, preferably, in environment variables
  referenced with `secretEnv`. Minimum length 32 characters; generate with
  `npm run app:generate` (32 random bytes).
- `apps.json` and `.env` are git-ignored. Restrict permissions:
  `chmod 600 apps.json .env`.
- The SDK contains no signing code; a test asserts this.
- Laravel: secret only in `.env` / config; the `Signer` constructor uses
  `#[SensitiveParameter]` so it is hidden from stack traces.

### TLS / WSS
DynamicSocket speaks plain HTTP/WS. In production, terminate TLS in a reverse
proxy (nginx, Caddy, Apache, LiteSpeed, cloud LB) and expose only `wss://` and
`https://`. Bind DynamicSocket to `127.0.0.1` (`DS_HOST`) so it is not
reachable without TLS. Browsers on `https://` pages refuse `ws://` (mixed
content) anyway. The publish API may use plain HTTP only over a private
network/loopback.

### SSRF
DynamicSocket makes no outbound network requests (no webhooks, no URL
fetching), so client- or backend-controlled input cannot direct it to
internal services.

## Token revocation, logout and key rotation

**Logout.** Call `POST /v1/disconnect` with the user id (the Laravel example
does this from a `Logout` listener). Existing sockets close with `4010`. A new
socket needs a new token, which the backend will not issue to a logged-out
session.

**Revocation of an individual token.** Not supported as a list. Bounds:
tokens are single-use and expire within `DS_TOKEN_MAX_TTL_SECONDS`; an
unused stolen token is usable for at most its remaining lifetime (≤ 5 min with
the recommended TTL). Once used, it cannot be used again.

**Permission changes.** Grants are fixed in the token. To apply a revocation
immediately, call `/v1/disconnect` for the user; the client reconnects (if
configured) with a token reflecting new permissions. Otherwise changes apply
within `DS_MAX_SESSION_SECONDS` (default 1 h).

**Key rotation (zero downtime).**
1. Add a new key to the app (`{"id":"2026-11","secretEnv":"..."}`) next to the
   old one; restart DynamicSocket. Both keys are accepted.
2. Switch the backend to the new key id/secret; deploy.
3. Wait for `DS_TOKEN_MAX_TTL_SECONDS` + `DS_SIGNATURE_TOLERANCE_SECONDS`.
4. Remove the old key; restart. Tokens/requests signed with it are rejected
   (test: `tests/security/isolation.test.js`).

Restarts drop all sockets; clients reconnect automatically. Hot reload of
configuration is not implemented.

**Compromised secret.** Remove the key immediately (restart), then rotate as
above. All sockets of that app can be dropped by restarting.

## Remaining risks (0.1)

1. Replay window after restart (described above).
2. Per-process state (including presence): horizontal scaling requires the planned shared adapters.
3. No per-token revocation list; mitigated by single use + short TTL + session cap + disconnect API.
4. Volumetric DDoS needs network-level protection.
5. Any user granted a channel sees every event on it; design channel names and
   grants carefully (prefer `user.{id}` / `team.{id}.*` over broad wildcards).
6. Events are delivered as provided by the backend; do not put data in an event
   that every subscriber of that channel should not see. Treat `data` as
   untrusted in the browser when it contains user-generated content (escape
   before inserting into HTML).
7. The `ws` dependency is the protocol parser; keep it updated (`npm audit` runs in CI).

## Reporting

Report vulnerabilities privately to the maintainers rather than in a public
issue.
