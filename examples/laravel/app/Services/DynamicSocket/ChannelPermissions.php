<?php

declare(strict_types=1);

namespace App\Services\DynamicSocket;

use App\Models\Order;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\Gate;

/**
 * Derives the channels a user may subscribe to from the application's real
 * authorization rules. The result is embedded in the signed client token and
 * enforced by DynamicSocket on every subscribe.
 *
 * Adapt the rules below to your models, policies and roles. Keep the list
 * small (max 100 entries) and prefer narrow names over broad wildcards.
 */
final class ChannelPermissions
{
    /** @return list<string> */
    public function forUser(Authenticatable $user): array
    {
        $id = (string) $user->getAuthIdentifier();

        // Every user may receive their own private notifications.
        $channels = ["user.{$id}"];

        // Staff who may view all orders get the shared orders feed.
        if (Gate::forUser($user)->allows('viewAny', Order::class)) {
            $channels[] = 'orders';
        }

        // Team-scoped channels, e.g. "team.17.inventory", "team.17.chat.*" and the
        // team's presence channel "presence.team.17" (who of my team is online).
        if (method_exists($user, 'teams')) {
            foreach ($user->teams()->pluck('teams.id') as $teamId) {
                $channels[] = "team.{$teamId}.inventory";
                $channels[] = "team.{$teamId}.chat.*";
                $channels[] = "presence.team.{$teamId}";
            }
        }

        // The app-wide "online" presence channel needs no grant if it is listed in
        // the app's publicChannels (see apps.example.json).

        return array_values(array_unique($channels));
    }
}
