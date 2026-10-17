<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Services\DynamicSocket\DynamicSocketClient;
use App\Services\DynamicSocket\DynamicSocketException;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Str;

/**
 * Publishes one DynamicSocket event from a queue worker.
 *
 * - afterCommit(): when dispatched inside DB::transaction(), the job is only
 *   queued once the transaction commits, so clients never hear about rows
 *   that were rolled back.
 * - The message id is fixed at dispatch time. If a retry re-sends a message
 *   whose first attempt actually went out (e.g. the HTTP response was lost),
 *   clients receive the same id twice and can de-duplicate on it.
 * - Non-retryable failures (validation, signature) fail the job immediately.
 */
final class PublishDynamicSocketEvent implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 5;

    public string $messageId;

    /**
     * @param  list<string>  $channels
     * @param  list<string|int>  $users
     */
    public function __construct(
        public string $event,
        public array $channels = [],
        public array $users = [],
        public mixed $data = null,
        ?string $messageId = null,
    ) {
        $this->messageId = $messageId ?? (string) Str::uuid();
        $this->afterCommit();
    }

    /** @return list<int> seconds between attempts */
    public function backoff(): array
    {
        return [1, 5, 15, 60];
    }

    public function handle(DynamicSocketClient $client): void
    {
        try {
            $client->publish($this->event, $this->channels, $this->users, $this->data, $this->messageId);
        } catch (DynamicSocketException $e) {
            if (! $e->isRetryable()) {
                $this->fail($e);

                return;
            }
            if ($e->retryAfter !== null) {
                $this->release($e->retryAfter);

                return;
            }
            throw $e;
        }
    }
}
