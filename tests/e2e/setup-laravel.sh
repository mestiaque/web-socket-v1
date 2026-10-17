#!/usr/bin/env bash
# Creates a fresh Laravel app, installs the files from examples/laravel plus
# the test-only overlay, and prepares the database. Usage:
#   tests/e2e/setup-laravel.sh <target-dir>
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:?usage: setup-laravel.sh <target-dir>}"
EX="$REPO/examples/laravel"

if [ ! -f "$APP/artisan" ]; then
  composer create-project laravel/laravel "$APP" "^13.0" --no-interaction --prefer-dist
fi
cd "$APP"

# Example integration files (as a user would copy them)
cp "$EX/config/dynamicsocket.php" config/
mkdir -p app/Support/DynamicSocket app/Services/DynamicSocket app/Http/Controllers app/Jobs app/Listeners app/Providers
cp "$EX"/app/Support/DynamicSocket/*.php app/Support/DynamicSocket/
cp "$EX"/app/Services/DynamicSocket/*.php app/Services/DynamicSocket/
cp "$EX"/app/Http/Controllers/*.php app/Http/Controllers/
cp "$EX"/app/Jobs/*.php app/Jobs/
cp "$EX"/app/Listeners/*.php app/Listeners/
cp "$EX"/app/Providers/DynamicSocketServiceProvider.php app/Providers/
cp "$EX/resources/js/layout-snippet.blade.php" resources/views/dynamicsocket-meta.blade.php
mkdir -p public/js/vendor
cp "$EX/resources/js/realtime.js" public/js/realtime.js
cp "$REPO/sdk/dynamicsocket.js" public/js/vendor/dynamicsocket.js

# Test-only overlay (models, migration, routes, dashboard view)
cp -r "$REPO/tests/e2e/laravel-overlay/." .

# Register the provider
grep -q DynamicSocketServiceProvider bootstrap/providers.php || \
  sed -i -E 's/^([[:space:]]*)((App\\Providers\\)?AppServiceProvider::class,)/\1\2\n\1App\\Providers\\DynamicSocketServiceProvider::class,/' bootstrap/providers.php
grep -q DynamicSocketServiceProvider bootstrap/providers.php || { echo "could not register provider" >&2; exit 1; }

set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
set_env APP_URL http://127.0.0.1:8000
set_env QUEUE_CONNECTION database
set_env DYNAMICSOCKET_APP_ID shop
set_env DYNAMICSOCKET_KEY_ID k1
set_env DYNAMICSOCKET_SECRET "${DYNAMICSOCKET_SECRET:-e2e-secret-0123456789abcdef0123456789abcdef}"
set_env DYNAMICSOCKET_HTTP_URL http://127.0.0.1:6201
set_env DYNAMICSOCKET_WS_URL ws://127.0.0.1:6201/ws

php artisan migrate:fresh --force
php artisan tinker --execute '
  foreach ([1 => "Alice", 2 => "Bob"] as $id => $name) {
    App\Models\User::create(["name" => $name, "email" => strtolower($name)."@example.test", "password" => bcrypt(Str::random(32))]);
  }
  DB::table("products")->insert(["name" => "Widget", "created_at" => now(), "updated_at" => now()]);
'
echo "Laravel app ready in $APP"
