<?php

// config/dynamicsocket.php
// Every value comes from the environment; the secret never leaves the server.

return [
    // Must match an "id" in the DynamicSocket apps file.
    'app_id' => env('DYNAMICSOCKET_APP_ID'),

    // Key id + secret pair from the DynamicSocket apps file ("keys" entry).
    'key_id' => env('DYNAMICSOCKET_KEY_ID'),
    'secret' => env('DYNAMICSOCKET_SECRET'),

    // Server-to-server base URL used for signed publish requests. Prefer a
    // private address or the internal hostname when Laravel and DynamicSocket
    // share a network; otherwise use https://.
    'http_url' => env('DYNAMICSOCKET_HTTP_URL', 'http://127.0.0.1:6001'),

    // Public WebSocket URL handed to browsers (wss:// in production).
    'ws_url' => env('DYNAMICSOCKET_WS_URL', 'ws://127.0.0.1:6001/ws'),

    // Client token lifetime in seconds. Must not exceed DS_TOKEN_MAX_TTL_SECONDS.
    'token_ttl' => (int) env('DYNAMICSOCKET_TOKEN_TTL', 300),

    // HTTP timeouts (seconds) for publish requests.
    'timeout' => (float) env('DYNAMICSOCKET_TIMEOUT', 5),
    'connect_timeout' => (float) env('DYNAMICSOCKET_CONNECT_TIMEOUT', 2),
];
