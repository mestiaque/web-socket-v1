// resources/js/realtime.js
// Copy sdk/dynamicsocket.js from the DynamicSocket repository to
// resources/js/vendor/dynamicsocket.js. It contains no secrets.
import { DynamicSocket } from './vendor/dynamicsocket.js';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

export const realtime = new DynamicSocket({
  url: meta('dynamicsocket-url'), // e.g. wss://ws.example.com/ws
  appId: meta('dynamicsocket-app'), // e.g. shop
  // Called on every (re)connect: tokens are short-lived and single-use.
  token: async () => {
    const response = await fetch('/dynamicsocket/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-TOKEN': meta('csrf-token') },
    });
    if (!response.ok) throw new Error(`token request failed: ${response.status}`);
    return (await response.json()).token;
  },
});

realtime.on('state', ({ state }) => {
  document.documentElement.dataset.realtime = state;
});
realtime.on('auth_error', ({ code }) => console.warn('realtime auth error', code));

// Application events ---------------------------------------------------------
const seen = new Set();
realtime.listen('order.created', (data, meta) => {
  if (seen.has(meta.id)) return; // de-duplicate retried publishes
  seen.add(meta.id);
  console.log('new order', data.order_id, 'via', meta.channel);
});

// Online / offline -----------------------------------------------------------
// "online" is a presence channel: every logged-in user joins it, and every
// member receives join/leave updates. members() has one entry per user.
export function renderOnlineUsers(element) {
  const render = () => {
    element.replaceChildren(
      ...realtime.members('online').map((m) => {
        const li = document.createElement('li');
        li.textContent = m.info?.name ?? `User ${m.id}`; // textContent: never inject HTML
        li.dataset.userId = m.id;
        return li;
      }),
    );
  };
  return realtime.onPresence('online', render);
}

realtime.connect().then(() => {
  realtime.subscribe(`user.${meta('user-id')}`).catch((err) => console.warn(err.code, err.channel));
  realtime.subscribe('online').catch((err) => console.warn(err.code, err.channel));
});
