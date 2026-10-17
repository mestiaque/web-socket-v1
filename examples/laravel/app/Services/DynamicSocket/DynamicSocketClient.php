<?php

declare(strict_types=1);

namespace App\Services\DynamicSocket;

use App\Support\DynamicSocket\Signer;
use Illuminate\Support\Facades\Http;

/**
 * Sends signed requests to the DynamicSocket HTTP API.
 *
 * A successful publish means DynamicSocket accepted the message and attempted
 * a send to every matching socket it currently holds ("delivery.sent").
 * It does NOT mean a browser received it. There is no durable queue on the
 * DynamicSocket side: if nobody is subscribed, the message is gone.
 */
final class DynamicSocketClient
{
    public function __construct(
        private readonly Signer $signer,
        private readonly string $baseUrl,
        private readonly float $timeout = 5.0,
        private readonly float $connectTimeout = 2.0,
    ) {}

    /**
     * @param  list<string>  $channels
     * @param  list<string|int>  $users
     * @return array{ok: bool, id: string, acceptedAt: string, delivery: array{scope: string, recipients: int, sent: int, dropped: int}}
     */
    public function publish(string $event, array $channels = [], array $users = [], mixed $data = null, ?string $id = null): array
    {
        $payload = [
            'channels' => array_values($channels),
            'users' => array_map('strval', array_values($users)),
            'event' => $event,
            'data' => $data,
        ];
        if ($id !== null) {
            $payload['id'] = $id;
        }

        return $this->send('/v1/publish', $payload);
    }

    /**
     * Closes every active socket of the given users in this application.
     *
     * @param  list<string|int>  $userIds
     * @return array{ok: bool, closed: int}
     */
    public function disconnectUsers(array $userIds): array
    {
        return $this->send('/v1/disconnect', ['users' => array_map('strval', array_values($userIds))]);
    }

    /**
     * Online state from DynamicSocket's point of view.
     *
     * - $users: which of these users currently have at least one open, authenticated connection.
     * - $channel: member list of a presence channel.
     *
     * @param  list<string|int>|null  $users
     * @return array{ok: bool, users?: array<string, bool>, channel?: array{name: string, presence: bool, subscriptions: int, count?: int, members?: list<array{id: string, info: mixed}>}}
     */
    public function presence(?array $users = null, ?string $channel = null): array
    {
        $payload = [];
        if ($users !== null) {
            $payload['users'] = array_map('strval', array_values($users));
        }
        if ($channel !== null) {
            $payload['channel'] = $channel;
        }

        return $this->send('/v1/presence', $payload);
    }

    public function isOnline(string|int $userId): bool
    {
        return (bool) ($this->presence([$userId])['users'][(string) $userId] ?? false);
    }

    private function send(string $path, array $payload): array
    {
        $body = Signer::json($payload);
        $headers = $this->signer->signRequest('POST', $path, $body);

        $response = Http::withHeaders($headers)
            ->withBody($body, 'application/json')
            ->acceptJson()
            ->timeout($this->timeout)
            ->connectTimeout($this->connectTimeout)
            ->post(rtrim($this->baseUrl, '/').$path);

        if ($response->failed()) {
            throw DynamicSocketException::fromResponse($response);
        }

        return $response->json();
    }
}
