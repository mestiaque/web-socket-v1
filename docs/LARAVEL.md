# Laravel integration

DynamicSocket does not depend on Laravel. Laravel integrates through two
contracts (see [API.md](API.md)):

1. **Client tokens** issued by Laravel to logged-in users.
2. **Signed HTTP requests** from Laravel to `POST /v1/publish` and `/v1/disconnect`.

Complete example files are in [`examples/laravel/`](../examples/laravel):

| File | Purpose |
|---|---|
| `config/dynamicsocket.php` | Configuration from environment variables |
| `app/Support/DynamicSocket/Signer.php` | Token issuing + request signing (framework-free, PHP ≥ 8.1) |
| `app/Services/DynamicSocket/DynamicSocketClient.php` | Publish / disconnect / presence queries via Laravel's HTTP client |
| `app/Services/DynamicSocket/DynamicSocketException.php` | Error type with `isRetryable()` |
| `app/Services/DynamicSocket/ChannelPermissions.php` | Derives channel grants from real permissions |
| `app/Http/Controllers/DynamicSocketTokenController.php` | Token endpoint |
| `app/Jobs/PublishDynamicSocketEvent.php` | Queued, after-commit publishing with retries |
| `app/Listeners/DisconnectDynamicSocketOnLogout.php` | Closes sockets on logout |
| `app/Providers/DynamicSocketServiceProvider.php` | Container bindings + listener registration |
| `app/Http/Controllers/OrderController.php` | Publishing inside a DB transaction |
| `routes/dynamicsocket.php` | Route definitions (session and Sanctum) |
| `resources/js/realtime.js`, `resources/js/layout-snippet.blade.php` | Frontend initialization |

**Verification status.** Two automated checks:

1. `tests/integration/laravel-contract.test.js` (part of `npm test`): runs
   `Signer.php` with PHP and checks the server accepts its tokens and
   signatures.
2. `npm run test:e2e` — a full end-to-end test. `tests/e2e/setup-laravel.sh`
   creates a fresh Laravel 13 app, copies these example files into it exactly
   as described below (plus a small test-only overlay: an `orders` table,
   routes and a dashboard view), and `tests/e2e/laravel-browser.e2e.mjs` runs
   the real DynamicSocket process, `php artisan serve`, `php artisan
   queue:work` and headless Google Chrome. It verifies: session login → token
   endpoint → WebSocket auth; online list for two users; `presence()` query
   from Laravel; order created in a DB transaction → after-commit queued job →
   signed publish → event in the right browser only; page reload without an
   offline flicker; logout → `/v1/disconnect` → close 4010 → other user sees
   the member leave; token endpoint returns 401 after logout; no browser
   console errors; no secrets in logs. Last run (2026-10-17): Laravel Framework 13.37.0, PHP 8.4.26,
   Chrome 155, Node 20.18 — passed.

```bash
npm run test:e2e:setup -- /tmp/ds-laravel     # needs composer + network
npm run test:e2e -- /tmp/ds-laravel           # needs php + google-chrome (or CHROME_BIN)
```

## 1. Configure DynamicSocket

```bash
npm run app:generate -- --id shop --key k1 --origin https://shop.example.com
```

Put the printed `DS_SHOP_SECRET_K1=...` in DynamicSocket's environment and the
printed JSON entry in its `apps.json`. Restart DynamicSocket.

## 2. Configure Laravel

Copy the example files into your app (keep the namespaces or adjust them),
register the provider (Laravel 11+: `bootstrap/providers.php`; older:
`config/app.php`):

```php
return [
    AppServiceProvider::class,
    App\Providers\DynamicSocketServiceProvider::class,
];
```

The logout listener in `app/Listeners` is picked up by Laravel's event
discovery (on by default since Laravel 11). If your app disables discovery,
register it yourself — but not both, or it runs twice (the end-to-end test
caught exactly this).

`.env`:

```dotenv
DYNAMICSOCKET_APP_ID=shop
DYNAMICSOCKET_KEY_ID=k1
DYNAMICSOCKET_SECRET=<same value as DS_SHOP_SECRET_K1>
DYNAMICSOCKET_HTTP_URL=http://127.0.0.1:6001     # server-to-server
DYNAMICSOCKET_WS_URL=wss://ws.example.com/ws      # what browsers use
DYNAMICSOCKET_TOKEN_TTL=300
```

Run `php artisan config:cache` in production. Never expose
`DYNAMICSOCKET_SECRET` to Blade/JS — the layout snippet only exposes the URL
and app id.

## 3. Issue tokens

`DynamicSocketTokenController` signs a token for `$request->user()` with the
channels from `ChannelPermissions::forUser()`.

**Session-based apps (web guard, Blade/Inertia/Livewire):**

```php
// routes/web.php
Route::post('/dynamicsocket/token', DynamicSocketTokenController::class)
    ->middleware(['auth', 'throttle:30,1']);
```

The frontend sends the CSRF token (`X-CSRF-TOKEN`) with `credentials:
'same-origin'`.

**Token-based apps (Sanctum SPA/mobile, Passport, custom guards):**

```php
// routes/api.php
Route::post('/dynamicsocket/token', DynamicSocketTokenController::class)
    ->middleware(['auth:sanctum', 'throttle:30,1']);
```

The frontend sends its bearer token (`Authorization: Bearer ...`) to this
endpoint. Use whichever guard your app actually uses (`auth:api`,
`auth:admin`, …); the controller only needs `$request->user()`.

If you have several guards (e.g. `web` users and `admin` users), prefix the
subject so ids cannot collide: `issueClientToken('admin:'.$admin->id, ...)`.

## 4. Derive channel permissions

`ChannelPermissions::forUser()` is where private-channel authorization
happens — **before** the token is issued, using your real policies:

```php
$channels = ["user.{$id}"];
if (Gate::forUser($user)->allows('viewAny', Order::class)) {
    $channels[] = 'orders';
}
foreach ($user->teams()->pluck('teams.id') as $teamId) {
    $channels[] = "team.{$teamId}.chat.*";
}
```

DynamicSocket enforces exactly this list on every `subscribe`. Keep it under
100 entries; use narrow wildcards. Channels that every logged-in user may join
(e.g. `announcements`) can instead be listed in the app's `publicChannels`.

## 5. Publish events

Directly (synchronous, e.g. in a controller or listener):

```php
app(DynamicSocketClient::class)->publish(
    event: 'order.status_changed',
    channels: ['orders', "user.{$order->user_id}"],
    data: ['order_id' => $order->id, 'status' => $order->status],
    id: "order.{$order->id}.status.{$order->updated_at->timestamp}",
);
```

To specific users regardless of subscriptions:

```php
app(DynamicSocketClient::class)->publish('notification', users: [$user->id], data: [...]);
```

Any event name works; there is no PHP event class per event.

## 6. After-commit and queued publishing

Publishing inside a transaction that later rolls back would announce data
that does not exist. `PublishDynamicSocketEvent` calls `afterCommit()`, so when
dispatched inside `DB::transaction()` it is queued only after commit:

```php
DB::transaction(function () use (&$order, $data) {
    $order = Order::create($data);
    PublishDynamicSocketEvent::dispatch(
        'order.created',
        ['orders', "user.{$order->user_id}"],
        [],
        ['order_id' => $order->id, 'status' => $order->status],
        "order.{$order->id}.created",
    );
});
```

(Alternatively set `'after_commit' => true` on the queue connection in
`config/queue.php`.)

The job retries 429/5xx/connection errors with backoff (1, 5, 15, 60 s), honours
`Retry-After`, and fails immediately on 4xx validation/signature errors. The
message id is fixed at dispatch time so a retry after an ambiguous failure
produces a duplicate with the **same id**; the frontend example de-duplicates
by `meta.id`.

Run a worker: `php artisan queue:work`. With `QUEUE_CONNECTION=sync` the job
runs inline after commit.

Delivery remains best-effort (see API.md §1): a successful job means
DynamicSocket accepted the message, not that a browser received it.

## 7. Frontend

Add `resources/js/layout-snippet.blade.php` to your layout, copy
`sdk/dynamicsocket.js` to `resources/js/vendor/`, and import
`resources/js/realtime.js` from `app.js`. The token function is called on every
(re)connect because tokens are single-use. See [SDK.md](SDK.md).

## 8. Online / offline (presence)

1. In DynamicSocket's apps file, declare which channels are presence channels
   and let every logged-in user join the app-wide one:

   ```json
   "publicChannels": ["online"],
   "presenceChannels": ["online", "presence.*"]
   ```

   Restart DynamicSocket.

2. The token controller already sends public profile data with the token
   (`['name' => $user->name]`, 5th argument of `issueClientToken`). Only put
   data there that every other member may see.

3. Frontend (`resources/js/realtime.js`): it subscribes to `online` and
   `renderOnlineUsers(element)` keeps a list up to date:

   ```js
   import { realtime, renderOnlineUsers } from './realtime.js';
   renderOnlineUsers(document.getElementById('online-users'));
   realtime.onPresence('online', ({ action, member }) => { /* toast, badge, … */ });
   ```

4. Per-team / per-room presence: grant `presence.team.{id}` in
   `ChannelPermissions` (already in the example) and subscribe to it.

5. Server side, ask DynamicSocket:

   ```php
   $ds = app(DynamicSocketClient::class);
   $ds->isOnline($user->id);                       // bool
   $ds->presence(users: [1, 2, 3]);                // ['users' => ['1' => true, ...]]
   $ds->presence(channel: 'online');               // member list
   ```

Behaviour: one member per user (tabs/devices are merged); "offline" is
announced only after the user's last connection has been gone for
`DS_PRESENCE_LEAVE_GRACE_MS` (default 3 s), so reloads do not flicker; logout
removes the user immediately (plus the grace period). Presence lives in
DynamicSocket's memory: to keep a durable "last seen" timestamp, store it in
Laravel yourself (e.g. update `last_seen_at` in the token endpoint, or poll
`presence()` from a scheduled command). DynamicSocket does not call back into
Laravel.

## 9. Logout and token expiry

- `DisconnectDynamicSocketOnLogout` calls `/v1/disconnect` for the user on
  Laravel's `Logout` event. This closes the user's sockets **on all devices**
  (close code `4010`). The SDK does not reconnect after `4010` by default. If
  users are commonly logged in on several devices, create the SDK with
  `reconnectOnServerDisconnect: true`: still-logged-in sessions get a new
  token and reconnect; the logged-out session's token request returns 401 and
  the SDK stops after `maxAuthFailures`.
- If DynamicSocket is unreachable during logout, logout still succeeds; the
  socket is closed at the latest after `DS_MAX_SESSION_SECONDS` and cannot
  reconnect.
- Expired tokens are rejected with `token_expired`; the SDK simply asks the
  token endpoint again.
- Use `/v1/disconnect` as well when you suspend a user or remove permissions.

## 10. Error handling

`DynamicSocketClient` throws `DynamicSocketException` with `status`,
`errorCode` and `retryAfter`. Connection failures surface as Laravel's
`Illuminate\Http\Client\ConnectionException`. Decide per call site whether a
failed realtime notification should fail the request (usually not: log it, or
use the queued job).

## 11. Testing in Laravel

Fake outbound requests in feature tests:

```php
Http::fake(['*/v1/publish' => Http::response(['ok' => true, 'id' => 'x', 'acceptedAt' => now()->toIso8601String(),
    'delivery' => ['scope' => 'local', 'recipients' => 0, 'sent' => 0, 'dropped' => 0]])]);
// ... act ...
Http::assertSent(fn ($r) => $r->url() === config('dynamicsocket.http_url').'/v1/publish'
    && $r['event'] === 'order.created');
```

Use `Queue::fake()` to assert `PublishDynamicSocketEvent` was dispatched.
