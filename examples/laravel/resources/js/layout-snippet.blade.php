{{-- Add to your main layout <head>. Only public values are exposed. --}}
<meta name="csrf-token" content="{{ csrf_token() }}">
<meta name="dynamicsocket-url" content="{{ config('dynamicsocket.ws_url') }}">
<meta name="dynamicsocket-app" content="{{ config('dynamicsocket.app_id') }}">
@auth
<meta name="user-id" content="{{ auth()->id() }}">
@endauth
