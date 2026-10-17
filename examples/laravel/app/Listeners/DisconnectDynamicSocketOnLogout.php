<?php

declare(strict_types=1);

namespace App\Listeners;

use App\Services\DynamicSocket\DynamicSocketClient;
use Illuminate\Auth\Events\Logout;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Closes the user's open DynamicSocket connections when they log out.
 *
 * Note: this closes the user's sockets on ALL devices/tabs. Sessions that are
 * still logged in elsewhere can reconnect if the SDK is created with
 * `reconnectOnServerDisconnect: true` (their token request still succeeds;
 * the logged-out session's token request returns 401).
 */
final class DisconnectDynamicSocketOnLogout
{
    public function __construct(private readonly DynamicSocketClient $client) {}

    public function handle(Logout $event): void
    {
        if ($event->user === null) {
            return;
        }

        try {
            $this->client->disconnectUsers([(string) $event->user->getAuthIdentifier()]);
        } catch (Throwable $e) {
            // Logout must not fail because the realtime server is down. The
            // socket is still bounded by DS_MAX_SESSION_SECONDS and cannot
            // reconnect without a new token.
            Log::warning('DynamicSocket disconnect on logout failed', ['exception' => $e::class]);
        }
    }
}
