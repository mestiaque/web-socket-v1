<?php

declare(strict_types=1);

namespace App\Support\DynamicSocket;

use InvalidArgumentException;
use SensitiveParameter;

/**
 * Framework-independent implementation of the DynamicSocket token and
 * request-signature contracts (see docs/API.md). Keep this class on the
 * server only: it holds the application secret.
 */
final class Signer
{
    public const SCHEME = 'DS1-HMAC-SHA256';

    public function __construct(
        private readonly string $appId,
        private readonly string $keyId,
        #[SensitiveParameter] private readonly string $secret,
    ) {
        if ($appId === '' || $keyId === '') {
            throw new InvalidArgumentException('DynamicSocket app id and key id are required.');
        }
        if (strlen($secret) < 32) {
            throw new InvalidArgumentException('DynamicSocket secret must be at least 32 characters.');
        }
    }

    public function appId(): string
    {
        return $this->appId;
    }

    /**
     * Issues a short-lived, single-use client token (JWT compact form, HS256).
     *
     * @param  list<string>  $channels  channel names or "prefix.*" patterns this user may subscribe to
     * @param  array<string, mixed>|null  $user  public profile shown to presence-channel members,
     *                                           e.g. ['name' => 'Alice']. Max 1 KiB of JSON. Never put secrets here.
     */
    public function issueClientToken(string $userId, array $channels, int $ttlSeconds = 300, ?int $now = null, ?array $user = null): string
    {
        $iat = $now ?? time();
        $header = ['alg' => 'HS256', 'typ' => 'JWT', 'kid' => $this->keyId];
        $claims = [
            'appId' => $this->appId,
            'sub' => $userId,
            'iat' => $iat,
            'exp' => $iat + $ttlSeconds,
            'jti' => self::base64Url(random_bytes(16)),
            'channels' => array_values(array_unique($channels)),
        ];
        if ($user !== null && $user !== []) {
            if (array_is_list($user)) {
                throw new InvalidArgumentException('DynamicSocket user info must be an associative array.');
            }
            $claims['user'] = $user;
        }

        $input = self::base64Url(self::json($header)).'.'.self::base64Url(self::json($claims));

        return $input.'.'.self::base64Url(hash_hmac('sha256', $input, $this->secret, true));
    }

    /**
     * Returns the headers that authenticate one HTTP request. The body passed
     * here must be byte-for-byte the body that is sent.
     *
     * @return array<string, string>
     */
    public function signRequest(string $method, string $path, string $body, ?int $now = null, ?string $nonce = null): array
    {
        $timestamp = (string) ($now ?? time());
        $nonce ??= self::base64Url(random_bytes(18));

        $canonical = implode("\n", [
            self::SCHEME,
            strtoupper($method),
            $path,
            $this->appId,
            $this->keyId,
            $timestamp,
            $nonce,
            hash('sha256', $body),
        ]);

        return [
            'X-DS-App' => $this->appId,
            'X-DS-Key' => $this->keyId,
            'X-DS-Timestamp' => $timestamp,
            'X-DS-Nonce' => $nonce,
            'X-DS-Signature' => hash_hmac('sha256', $canonical, $this->secret),
        ];
    }

    public static function json(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    public static function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
}
