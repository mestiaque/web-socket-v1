# Troubleshooting

Start with the logs (JSON lines on stdout; set `DS_LOG_LEVEL=debug` for
per-connection detail) and `GET /healthz`.

## Server does not start

| Message / exit code | Fix |
|---|---|
| Exit 78 + `Invalid configuration:` list | Fix every listed item. Secrets ≥ 32 chars; `secretEnv` variables must be set; origins must be `scheme://host[:port]` without path or trailing slash. |
| `No applications configured` | Set `DS_APPS_FILE` or `DS_APPS_JSON`. |
| `EADDRINUSE` | Another process uses `DS_PORT`. |
| `ERR_REQUIRE_ESM` (cPanel/Passenger) | Startup file must be `app.cjs`. |
| `process.loadEnvFile is not a function` | Node < 20.12. Upgrade Node. |

## Browser cannot connect (close code 1006)

Handshake rejections are HTTP responses that browsers hide. Check the server
log (`upgrade rejected by origin policy`) and `ds_upgrades_rejected_total`
by `reason`, or reproduce with curl:

```bash
curl -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://shop.example.com" "https://ws.example.com/ws?app=shop"
```

| Status | Cause |
|---|---|
| 400 | Missing `?app=` |
| 403 | Unknown app id, or page Origin not in `allowedOrigins` (exact match: scheme, host and port) |
| 404 | `DS_WS_PATH` differs from the URL path |
| 429 | Per-IP connection or upgrade limit. Behind a proxy without `DS_TRUSTED_PROXIES`, all users share the proxy's IP. |
| 503 | Connection limit, or shutting down |
| HTML page / 200 / 502 | Reverse proxy is not forwarding the Upgrade (see nginx config or CPANEL.md) |

Also: an `https://` page cannot open `ws://` (mixed content) — use `wss://`.

## Connects, then closes

| Close code / error | Cause |
|---|---|
| 4001 `auth_failed` | Wrong secret/key id, token for another app, lifetime > `DS_TOKEN_MAX_TTL_SECONDS`, bad claims. Compare with docs/API.md §3. |
| 4001 `token_expired` | Clock skew between Laravel and DynamicSocket servers (sync with NTP), or the token was cached. |
| 4001 `token_reused` | The same token used twice: pass a token **function** to the SDK; don't cache tokens; `Cache-Control: no-store` on the token endpoint. |
| 4002 | No `auth` within `DS_AUTH_TIMEOUT_MS` (slow token endpoint?) |
| 4000 | Normal session expiry (`DS_MAX_SESSION_SECONDS`); SDK reconnects. |
| 4009 | Client could not keep up (`DS_MAX_BUFFERED_BYTES`): large/many events or slow network. Reduce event size/volume or raise the limit. |
| 4010 | Backend called `/v1/disconnect` (logout). |
| 4029 | Client sends too many messages, or too many failed auths from that IP. |
| 1009 | Client message larger than `DS_MAX_PAYLOAD_BYTES`. |
| Periodic 1006 every N seconds | Proxy idle/hard timeout. Raise `proxy_read_timeout`; heartbeat must be shorter than it. |

## Subscribe returns `forbidden`

The channel is neither in the app's `publicChannels` nor in the token's
`channels`. Decode the token payload (second segment, base64url) to see the
grants; check `ChannelPermissions::forUser()`. Remember `private-` prefixes
mean nothing.

## Publish errors

| Status / code | Cause |
|---|---|
| 401 `invalid_signature` | Wrong secret/key, path differs from the one signed (e.g. a proxy prefix like `/realtime/v1/publish` — sign the path DynamicSocket receives), body modified after signing (re-encoding JSON, middleware), missing headers. |
| 401 `stale_request` | Clock difference > `DS_SIGNATURE_TOLERANCE_SECONDS`. Sync clocks. |
| 409 `replayed_request` | Nonce reused (retry logic must generate a new nonce per attempt — the example client does). |
| 413 | Body over `DS_MAX_PUBLISH_BODY_BYTES` (and nginx `client_max_body_size`). |
| 415 | Missing `Content-Type: application/json`. |
| 422 | Validation: channel/event name characters, unknown fields, no targets. |
| 429 | App publish rate limit (`Retry-After`), or too many bad signatures from this IP. |
| 503 `capacity_exceeded` | Nonce store full: raise `DS_NONCE_STORE_MAX` or lower the publish rate / tolerance. |

## Published but not received

- `delivery.recipients: 0`: nobody subscribed to that channel *in that app* at
  that moment (check app id, exact channel name, and that the client got
  `subscribed`).
- `sent > 0` but the browser shows nothing: listener registered for a
  different event name, or with a `channel` filter that does not match.
- Intermittent: more than one server process (compare `instanceId` from
  `/healthz` across requests), or the client was reconnecting at that moment.
  DynamicSocket does not store messages (API.md §1).

## Debugging tips

- `npm run token:issue` and `npm run publish:signed` use the local config, so
  you can test the server independently of Laravel.
- `DS_LOG_LEVEL=debug` logs connection open/close, auth results and publishes
  (never tokens or secrets).
- Metrics: `curl -H "Authorization: Bearer $DS_METRICS_TOKEN" localhost:6001/metrics`.
