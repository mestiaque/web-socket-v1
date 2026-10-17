# JavaScript SDK

`sdk/dynamicsocket.js` is a dependency-free ES module for browsers (and
Node.js with a WebSocket implementation). It contains no secrets and cannot
create tokens or publish events.

## Install

Copy `sdk/dynamicsocket.js` into your frontend source (e.g.
`resources/js/vendor/dynamicsocket.js`) and import it. Bundlers (Vite,
webpack) handle it as a normal ES module. Without a bundler use
`<script type="module">`.

## Quick start

```js
import { DynamicSocket } from './vendor/dynamicsocket.js';

const socket = new DynamicSocket({
  url: 'wss://ws.example.com/ws',
  appId: 'shop',
  token: async () => {
    const res = await fetch('/dynamicsocket/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-TOKEN': document.querySelector('meta[name=csrf-token]').content },
    });
    if (!res.ok) throw new Error(`token ${res.status}`);
    return (await res.json()).token;
  },
});

const off = socket.listen('order.created', (data, meta) => {
  console.log(data.order_id, meta.channel, meta.id);
});

await socket.connect();
await socket.subscribe('orders');
```

## Options

| Option | Default | Description |
|---|---|---|
| `url` | required | WebSocket endpoint (`wss://…/ws`). `?app=` is appended automatically. |
| `appId` | required | Application id. |
| `token` | required | Function returning a token (string or Promise), or a static string. **Use a function**: tokens are single-use, so each (re)connect needs a new one. A static token cannot reconnect. |
| `WebSocket` | `globalThis.WebSocket` | Implementation to use (pass `ws` in Node 20). |
| `reconnect` | `true` | Reconnect automatically. |
| `minReconnectDelayMs` | `500` | First backoff step. |
| `maxReconnectDelayMs` | `30000` | Backoff cap. |
| `reconnectFactor` | `2` | Exponential factor. |
| `maxAuthFailures` | `5` | Consecutive auth failures before giving up. |
| `heartbeatIntervalMs` | `25000` | Client `ping` interval; `0` disables. |
| `heartbeatTimeoutMs` | `10000` | Extra silence tolerated before declaring the connection dead. |
| `reconnectOnServerDisconnect` | `false` | Reconnect after `4010` (server-initiated disconnect, e.g. logout). |

Backoff delay for attempt *n*: `cap = min(max, min × factor^n)`, delay is
uniformly random in `[cap/2, cap]` ("equal jitter"). Reset after a successful
authentication. A browser `online` event triggers an immediate retry.

## Methods

| Method | Returns | Description |
|---|---|---|
| `connect()` | `Promise<void>` | Connects and authenticates. Resolves on `auth_ok`; rejects if the client gives up (static token rejected, `maxAuthFailures` reached, `4010`, `disconnect()`, `dispose()`). |
| `authenticate()` | `Promise<void>` | Fetches a token and sends `auth`. Called automatically after `hello`. |
| `subscribe(channel)` | `Promise<void \| { members }>` | Remembers the channel and subscribes (now or after connecting). Restored after every reconnect. Resolves with `{ members }` for presence channels. Rejects with `err.code` `forbidden` / `invalid_channel` / `subscription_limit` / `presence_full`; refused channels are forgotten. |
| `unsubscribe(channel)` | `void` | Unsubscribes and forgets. Pending `subscribe()` promises for it reject. |
| `subscriptions()` | `string[]` | Channels currently wanted. |
| `listen(event, cb, { channel }?)` | `() => void` | Calls `cb(data, meta)` for that event name (`"*"` = all). Adding the same (event, channel, cb) twice is ignored. Returns a function that removes the listener. |
| `stopListening(event, cb, { channel }?)` | `void` | Removes a listener. |
| `members(channel)` | `{ id, info }[]` | Current members of a presence channel (one per user). |
| `isMember(channel, id)` | `boolean` | Whether that user is in the presence channel. |
| `onPresence(channel, cb)` | `() => void` | `cb({ action, channel, member, members })` with action `sync` (full list after each (re)subscribe), `member_added`, `member_removed`. Duplicates ignored. |
| `on(name, handler)` | `() => void` | Lifecycle events (below). |
| `emitControlMessage(msg)` | `void` | Sends a raw `ping`, `subscribe` or `unsubscribe`. Anything else throws: clients cannot publish. |
| `disconnect()` | `void` | Closes with 1000 and stops reconnecting. Subscriptions and listeners are kept for a later `connect()`. |
| `dispose()` | `void` | Disconnects and releases all listeners, timers and pending promises. The instance cannot be reused. |

`meta` = `{ id, event, channel, target, sentAt }`. `channel` is `null` and
`target` is `"user"` for user-targeted events. The same `id` can arrive twice
(multiple matching channels, or backend retries); de-duplicate if it matters.

## Lifecycle events (`on`)

| Name | Payload |
|---|---|
| `state` | `{ state, previous }` — `idle`, `connecting`, `authenticating`, `connected`, `reconnecting`, `disconnected`, `disposed` |
| `connected` | `{ connectionId, sub, sessionExpiresAt }` |
| `disconnected` | `{ code, reason, willReconnect }` |
| `reconnect_scheduled` | `{ attempt, delayMs }` |
| `auth_error` | `{ code, message }` — `auth_failed`, `token_expired`, `token_reused`, `auth_timeout`, `token_provider_failed` |
| `subscribed` | `{ channel }` |
| `subscription_error` | `{ channel, code, message }` |
| `presence` | `{ action, channel, member, members }` (all presence channels) |
| `error` | `Error` (server error messages, listener exceptions, invalid frames) |

## Online / offline (presence)

```js
const list = document.getElementById('online');
socket.onPresence('online', ({ action, member, members }) => {
  list.replaceChildren(...members.map((m) => Object.assign(document.createElement('li'), { textContent: m.info?.name ?? m.id })));
  if (action === 'member_added') console.log(`${member.info?.name} came online`);
  if (action === 'member_removed') console.log(`user ${member.id} went offline`);
});
await socket.subscribe('online'); // must be a presence channel in the app config
socket.isMember('online', 42);    // true / false
```

While reconnecting, `members()` keeps the last known list; a fresh `sync`
replaces it after the automatic resubscribe. Use `textContent` (not
`innerHTML`) for names: they come from other users' profiles.

## Node.js

Node 22+ has a global `WebSocket`. On Node 20 pass the `ws` package; set an
Origin if the app requires one, or use an app with `allowMissingOrigin: true`
for server-side consumers:

```js
import WebSocket from 'ws';
class OriginWebSocket extends WebSocket {
  constructor(url) { super(url, { origin: 'https://shop.example.com' }); }
}
new DynamicSocket({ url, appId, token, WebSocket: OriginWebSocket });
```

## Security notes

- Never put an app secret into frontend code; the token endpoint lives on your backend.
- Treat `data` as untrusted when it may contain user content; escape before inserting into HTML.
- The SDK is tested in Node with `ws` (`tests/integration/sdk.test.js`,
  `tests/integration/presence.test.js`) and in headless Google Chrome through
  the Laravel end-to-end test (`npm run test:e2e`, see LARAVEL.md).
