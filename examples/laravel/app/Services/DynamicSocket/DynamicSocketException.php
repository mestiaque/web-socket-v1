<?php

declare(strict_types=1);

namespace App\Services\DynamicSocket;

use Illuminate\Http\Client\Response;
use RuntimeException;

final class DynamicSocketException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status = 0,
        public readonly ?string $errorCode = null,
        public readonly ?int $retryAfter = null,
    ) {
        parent::__construct($message, $status);
    }

    public static function fromResponse(Response $response): self
    {
        $error = $response->json('error') ?? [];

        return new self(
            sprintf('DynamicSocket request failed (%d %s)', $response->status(), $error['code'] ?? 'unknown'),
            $response->status(),
            $error['code'] ?? null,
            $response->header('Retry-After') !== '' ? (int) $response->header('Retry-After') : null,
        );
    }

    /** 429, 503 and other 5xx responses may succeed later; 4xx validation/auth errors will not. */
    public function isRetryable(): bool
    {
        return $this->status === 429 || $this->status >= 500;
    }
}
