<?php

// Add to routes/web.php (session-based auth, CSRF-protected POST):

use App\Http\Controllers\DynamicSocketTokenController;
use Illuminate\Support\Facades\Route;

Route::post('/dynamicsocket/token', DynamicSocketTokenController::class)
    ->middleware(['auth', 'throttle:30,1'])
    ->name('dynamicsocket.token');

// Or add to routes/api.php for SPAs / mobile apps using Sanctum tokens:
//
// Route::post('/dynamicsocket/token', DynamicSocketTokenController::class)
//     ->middleware(['auth:sanctum', 'throttle:30,1']);
