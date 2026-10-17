<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dashboard</title>
@include('dynamicsocket-meta')
</head>
<body>
<h1>Hello {{ auth()->user()->name }}</h1>
<h2>Online now</h2>
<ul id="online"></ul>
<script type="module">
import { realtime, renderOnlineUsers } from '/js/realtime.js';
// Recorder for the automated browser test.
window.__e2e = { events: [], states: [], presence: [], closes: [] };
realtime.listen('*', (data, meta) => __e2e.events.push({ event: meta.event, channel: meta.channel, id: meta.id, data }));
realtime.on('state', ({ state }) => __e2e.states.push(state));
realtime.on('disconnected', (d) => __e2e.closes.push(d.code));
realtime.onPresence('online', (p) => __e2e.presence.push({ action: p.action, member: p.member?.id ?? null, names: p.members.map((m) => m.info?.name).sort() }));
renderOnlineUsers(document.getElementById('online'));
window.realtime = realtime;
</script>
</body>
</html>
