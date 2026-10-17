<?php

declare(strict_types=1);

namespace App\Providers;

use App\Services\DynamicSocket\DynamicSocketClient;
use App\Support\DynamicSocket\Signer;
use Illuminate\Support\ServiceProvider;

final class DynamicSocketServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(Signer::class, fn () => new Signer(
            (string) config('dynamicsocket.app_id'),
            (string) config('dynamicsocket.key_id'),
            (string) config('dynamicsocket.secret'),
        ));

        $this->app->singleton(DynamicSocketClient::class, fn ($app) => new DynamicSocketClient(
            $app->make(Signer::class),
            (string) config('dynamicsocket.http_url'),
            (float) config('dynamicsocket.timeout', 5),
            (float) config('dynamicsocket.connect_timeout', 2),
        ));
    }

    // The logout listener (App\Listeners\DisconnectDynamicSocketOnLogout) is
    // registered by Laravel's event discovery (default since Laravel 11). If
    // discovery is disabled in your app, register it manually:
    //   Event::listen(\Illuminate\Auth\Events\Logout::class, \App\Listeners\DisconnectDynamicSocketOnLogout::class);
    // Do not do both, or the listener runs twice.
}
