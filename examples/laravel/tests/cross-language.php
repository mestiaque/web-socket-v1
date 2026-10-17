<?php

// Framework-free check used by tests/integration/laravel-contract.test.js:
// prints a token and a signed request produced by the PHP Signer so the Node
// server code can verify them.

declare(strict_types=1);

require __DIR__.'/../app/Support/DynamicSocket/Signer.php';

use App\Support\DynamicSocket\Signer;

[$script, $appId, $keyId, $secret] = $argv;
$signer = new Signer($appId, $keyId, $secret);

$body = Signer::json([
    'channels' => ['orders'],
    'users' => ['42'],
    'event' => 'order.created',
    'data' => ['order_id' => 1001, 'note' => 'Ünïcödé / slashes'],
]);

echo Signer::json([
    'token' => $signer->issueClientToken('42', ['orders', 'user.42', 'orders'], 300, null, ['name' => 'Ünïcödé User']),
    'body' => $body,
    'headers' => $signer->signRequest('POST', '/v1/publish', $body),
]);
