<?php

// Routes for the DynamicSocket end-to-end test app. "/e2e/login-as" exists only
// so the automated browser can log in; never add such a route to a real app.

use App\Http\Controllers\DynamicSocketTokenController;
use App\Http\Controllers\OrderController;
use App\Models\User;
use App\Services\DynamicSocket\DynamicSocketClient;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;

Route::get('/e2e/login-as/{user}', function (Request $request, User $user) {
    abort_unless(app()->environment('local', 'testing'), 404);
    Auth::login($user);
    $request->session()->regenerate();

    return redirect('/dashboard');
});

Route::middleware('auth')->group(function () {
    Route::view('/dashboard', 'dashboard');
    Route::post('/orders', [OrderController::class, 'store']);
    Route::get('/online', fn (DynamicSocketClient $client) => $client->presence(users: [1, 2, 3], channel: 'online'));
    Route::post('/logout', function (Request $request) {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    });
    Route::post('/dynamicsocket/token', DynamicSocketTokenController::class)->middleware('throttle:30,1');
});
