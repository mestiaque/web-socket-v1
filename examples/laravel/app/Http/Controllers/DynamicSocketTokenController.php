<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\DynamicSocket\ChannelPermissions;
use App\Support\DynamicSocket\Signer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Issues a short-lived DynamicSocket client token to the authenticated user.
 *
 * The route must be protected by your authentication middleware ("auth" for
 * session/web guards, "auth:sanctum" for SPA/API tokens) and rate limited.
 * Tokens are single-use: the SDK calls this endpoint on every (re)connect.
 */
final class DynamicSocketTokenController
{
    public function __invoke(Request $request, Signer $signer, ChannelPermissions $permissions): JsonResponse
    {
        $user = $request->user();
        abort_if($user === null, 401);

        $ttl = (int) config('dynamicsocket.token_ttl', 300);
        $token = $signer->issueClientToken(
            (string) $user->getAuthIdentifier(),
            $permissions->forUser($user),
            $ttl,
            null,
            // Public profile shown to other members of presence channels.
            ['name' => $user->name ?? null],
        );

        return response()
            ->json(['token' => $token, 'expiresIn' => $ttl])
            ->header('Cache-Control', 'no-store, private');
    }
}
