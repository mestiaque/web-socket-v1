/**
 * DynamicSocket browser / Node.js client SDK (ES module, no dependencies).
 *
 * This file contains NO secrets and cannot mint tokens. It obtains a
 * short-lived token from your backend (the `token` option) and can only send
 * control messages (auth, subscribe, unsubscribe, ping). Publishing events
 * happens server-side through the signed HTTP API.
 *
 * Usage:
 *   import { DynamicSocket } from './dynamicsocket.js';
 *   const socket = new DynamicSocket({
 *     url: 'wss://ws.example.com/ws',
 *     appId: 'shop',
 *     token: async () => (await fetch('/dynamicsocket/token', { credentials: 'same-origin' })).json().then((r) => r.token),
 *   });
 *   socket.listen('order.created', (data, meta) => console.log(meta.channel, data));
 *   await socket.connect();
 *   await socket.subscribe('orders');
 */

export const State = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  DISPOSED: 'disposed',
});

const CLOSE = Object.freeze({
  NORMAL: 1000,
  SESSION_EXPIRED: 4000,
  AUTH_FAILED: 4001,
  AUTH_TIMEOUT: 4002,
  SLOW_CONSUMER: 4009,
  DISCONNECTED: 4010,
  RATE_LIMITED: 4029,
  CLIENT_HEARTBEAT_TIMEOUT: 4900,
});

const CONTROL_TYPES = new Set(['ping', 'subscribe', 'unsubscribe']);
const SUBSCRIPTION_FATAL = new Set(['forbidden', 'invalid_channel', 'subscription_limit', 'presence_full']);

const DEFAULTS = {
  reconnect: true,
  minReconnectDelayMs: 500,
  maxReconnectDelayMs: 30_000,
  reconnectFactor: 2,
  maxAuthFailures: 5,
  heartbeatIntervalMs: 25_000,
  heartbeatTimeoutMs: 10_000,
  reconnectOnServerDisconnect: false,
};

export class DynamicSocket {
  /**
   * @param {object} options
   * @param {string} options.url WebSocket endpoint, e.g. wss://ws.example.com/ws
   * @param {string} options.appId application id configured on the server
   * @param {string | (() => string | Promise<string>)} options.token a token, or
   *   a function returning a fresh token. Use a function: tokens are single-use
   *   by default, so every (re)connect needs a new one.
   * @param {typeof WebSocket} [options.WebSocket] implementation (defaults to globalThis.WebSocket)
   */
  constructor(options) {
    if (!options || typeof options.url !== 'string' || typeof options.appId !== 'string') {
      throw new TypeError('DynamicSocket requires { url, appId, token }');
    }
    if (typeof options.token !== 'string' && typeof options.token !== 'function') {
      throw new TypeError('DynamicSocket "token" must be a string or a function returning a token');
    }
    this.options = { ...DEFAULTS, ...options };
    this.WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
    if (typeof this.WebSocketImpl !== 'function') throw new TypeError('No WebSocket implementation available; pass options.WebSocket');

    this.state = State.IDLE;
    this.ws = null;
    this.connectionId = null;
    this.attempt = 0;
    this.authFailures = 0;
    this.manualClose = false;
    this.channels = new Map(); // channel -> { confirmed: boolean, waiters: Array<{resolve, reject}> }
    this.listeners = []; // { event, channel, callback }
    this.presence = new Map(); // presence channel -> Map<memberId, { id, info }>
    this.presenceListeners = []; // { channel, callback }
    this.handlers = new Map(); // lifecycle event -> Set<fn>
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastMessageAt = 0;
    this.connectWaiters = [];
    this.onlineHandler = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Opens the connection. Resolves once authenticated; safe to call repeatedly. */
  connect() {
    if (this.state === State.DISPOSED) return Promise.reject(new Error('DynamicSocket has been disposed'));
    const promise = new Promise((resolve, reject) => {
      if (this.state === State.CONNECTED) resolve();
      else this.connectWaiters.push({ resolve, reject });
    });
    if (this.state === State.IDLE || this.state === State.DISCONNECTED) {
      this.manualClose = false;
      this.authFailures = 0;
      this.watchOnline();
      this.open();
    }
    return promise;
  }

  /** Closes the connection and stops reconnecting. Subscriptions are kept for a later connect(). */
  disconnect() {
    this.manualClose = true;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.detach(ws);
      this.ws = null;
      try {
        ws.close(CLOSE.NORMAL, 'client_disconnect');
      } catch {
        /* already closed */
      }
    }
    if (this.state !== State.DISPOSED) this.setState(State.DISCONNECTED);
    this.rejectConnectWaiters(new Error('Disconnected'));
    this.markSubscriptionsPending();
    this.emit('disconnected', { code: CLOSE.NORMAL, reason: 'client_disconnect', willReconnect: false });
  }

  /** Disconnects and releases every listener, timer and pending promise. */
  dispose() {
    if (this.state === State.DISPOSED) return;
    this.disconnect();
    this.setState(State.DISPOSED);
    for (const entry of this.channels.values()) for (const w of entry.waiters) w.reject(new Error('DynamicSocket disposed'));
    this.channels.clear();
    this.listeners = [];
    this.presence.clear();
    this.presenceListeners = [];
    this.handlers.clear();
    if (this.onlineHandler && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.onlineHandler);
    }
    this.onlineHandler = null;
  }

  /**
   * Sends the auth message with a freshly obtained token. Called
   * automatically after the server greeting; exposed for advanced flows.
   */
  async authenticate() {
    const ws = this.ws;
    if (!ws) throw new Error('Not connected');
    this.setState(State.AUTHENTICATING);
    let token;
    try {
      token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
      if (typeof token !== 'string' || token.length === 0) throw new Error('Token provider returned no token');
    } catch (err) {
      this.emit('auth_error', { code: 'token_provider_failed', message: err.message });
      if (this.ws === ws) this.dropConnection(CLOSE.AUTH_FAILED, 'token_provider_failed');
      return;
    }
    if (this.ws === ws) this.send({ type: 'auth', token });
  }

  // ------------------------------------------------------------ subscriptions

  /**
   * Subscribes to a channel. The subscription is remembered and restored
   * after every reconnect. Resolves when the server confirms (with
   * `{ members }` for presence channels); rejects if the server refuses
   * (e.g. forbidden, presence_full).
   */
  subscribe(channel) {
    if (typeof channel !== 'string' || channel.length === 0) return Promise.reject(new TypeError('channel must be a non-empty string'));
    if (this.state === State.DISPOSED) return Promise.reject(new Error('DynamicSocket has been disposed'));
    let entry = this.channels.get(channel);
    if (entry?.confirmed) return Promise.resolve(this.presence.has(channel) ? { members: this.members(channel) } : undefined);
    return new Promise((resolve, reject) => {
      if (!entry) {
        entry = { confirmed: false, waiters: [] };
        this.channels.set(channel, entry);
        if (this.state === State.CONNECTED) this.send({ type: 'subscribe', channel });
      }
      entry.waiters.push({ resolve, reject });
    });
  }

  /** Unsubscribes and forgets the channel (it will not be restored). */
  unsubscribe(channel) {
    const entry = this.channels.get(channel);
    if (!entry) return;
    this.channels.delete(channel);
    this.presence.delete(channel);
    for (const w of entry.waiters) w.reject(new Error('Unsubscribed before confirmation'));
    if (this.state === State.CONNECTED) this.send({ type: 'unsubscribe', channel });
  }

  /** Channels the client wants (confirmed or pending). */
  subscriptions() {
    return [...this.channels.keys()];
  }

  // ---------------------------------------------------------------- listeners

  /**
   * Registers a callback for an application event name ("*" for all).
   * Registering the same (event, channel, callback) twice has no effect.
   * @param {string} event
   * @param {(data: unknown, meta: { id: string, event: string, channel: string|null, target: string, sentAt: string }) => void} callback
   * @param {{ channel?: string }} [opts] only deliver events from this channel
   * @returns {() => void} function that removes the listener
   */
  listen(event, callback, opts = {}) {
    if (typeof event !== 'string' || typeof callback !== 'function') throw new TypeError('listen(event, callback) requires a string and a function');
    const channel = opts.channel;
    const exists = this.listeners.some((l) => l.event === event && l.channel === channel && l.callback === callback);
    if (!exists) this.listeners.push({ event, channel, callback });
    return () => this.stopListening(event, callback, opts);
  }

  stopListening(event, callback, opts = {}) {
    this.listeners = this.listeners.filter((l) => !(l.event === event && l.channel === opts.channel && l.callback === callback));
  }

  // ------------------------------------------------------------------ presence

  /**
   * Current members of a presence channel: [{ id, info }]. One entry per
   * user, however many tabs/devices they have open. Last known state is kept
   * while reconnecting and replaced by a fresh list after resubscribing.
   */
  members(channel) {
    return [...(this.presence.get(channel)?.values() ?? [])];
  }

  /** True if the user id is currently a member of the presence channel. */
  isMember(channel, id) {
    return this.presence.get(channel)?.has(String(id)) ?? false;
  }

  /**
   * Calls `callback({ action, channel, member, members })` on presence
   * changes. action: "sync" (full list after (re)subscribe), "member_added",
   * "member_removed". Duplicate registrations are ignored.
   * @returns {() => void} function that removes the listener
   */
  onPresence(channel, callback) {
    if (typeof channel !== 'string' || typeof callback !== 'function') throw new TypeError('onPresence(channel, callback) requires a string and a function');
    if (!this.presenceListeners.some((l) => l.channel === channel && l.callback === callback)) {
      this.presenceListeners.push({ channel, callback });
    }
    return () => {
      this.presenceListeners = this.presenceListeners.filter((l) => !(l.channel === channel && l.callback === callback));
    };
  }

  /**
   * Lifecycle events: state, connected, disconnected, reconnect_scheduled,
   * auth_error, subscribed, subscription_error, presence, error.
   * @returns {() => void} unsubscribe function
   */
  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
    return () => this.handlers.get(name)?.delete(handler);
  }

  /**
   * Sends a raw control message. Only "ping", "subscribe" and "unsubscribe"
   * are allowed; clients can never publish application events.
   */
  emitControlMessage(message) {
    if (!message || !CONTROL_TYPES.has(message.type)) throw new Error('Only ping, subscribe and unsubscribe control messages are allowed');
    if (this.state !== State.CONNECTED) throw new Error('Not connected');
    this.send(message);
  }

  // ---------------------------------------------------------------- internals

  buildUrl() {
    const sep = this.options.url.includes('?') ? '&' : '?';
    return `${this.options.url}${sep}app=${encodeURIComponent(this.options.appId)}`;
  }

  open() {
    this.clearTimers();
    this.setState(this.attempt === 0 ? State.CONNECTING : State.RECONNECTING);
    let ws;
    try {
      ws = new this.WebSocketImpl(this.buildUrl());
    } catch (err) {
      this.emit('error', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    ws.onmessage = (event) => this.onMessage(ws, event);
    ws.onclose = (event) => this.onClose(ws, event.code, event.reason);
    ws.onerror = () => {
      /* followed by close; browsers expose no details */
    };
  }

  detach(ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  send(message) {
    const OPEN = this.WebSocketImpl.OPEN ?? 1;
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  onMessage(ws, event) {
    if (ws !== this.ws) return;
    this.lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      this.emit('error', new Error('Received invalid JSON from server'));
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.connectionId = msg.connectionId;
        this.authenticate();
        break;
      case 'auth_ok':
        this.onAuthenticated(msg);
        break;
      case 'subscribed': {
        const entry = this.channels.get(msg.channel);
        if (!entry) break;
        entry.confirmed = true;
        let result;
        if (msg.presence) {
          this.presence.set(msg.channel, new Map(msg.presence.members.map((m) => [m.id, m])));
          result = { members: this.members(msg.channel) };
          this.emitPresence({ action: 'sync', channel: msg.channel, member: null });
        }
        for (const w of entry.waiters.splice(0)) w.resolve(result);
        this.emit('subscribed', { channel: msg.channel });
        break;
      }
      case 'presence':
        this.onPresenceMessage(msg);
        break;
      case 'unsubscribed':
      case 'pong':
        break;
      case 'event':
        this.dispatch(msg);
        break;
      case 'error':
        this.onServerError(msg);
        break;
      default:
        break;
    }
  }

  onAuthenticated(msg) {
    this.attempt = 0;
    this.authFailures = 0;
    this.setState(State.CONNECTED);
    this.startHeartbeat();
    for (const [channel, entry] of this.channels) {
      entry.confirmed = false;
      this.send({ type: 'subscribe', channel });
    }
    for (const w of this.connectWaiters.splice(0)) w.resolve();
    this.emit('connected', { connectionId: msg.connectionId, sub: msg.sub, sessionExpiresAt: msg.sessionExpiresAt });
  }

  onServerError(msg) {
    if (msg.channel && SUBSCRIPTION_FATAL.has(msg.code) && this.channels.has(msg.channel)) {
      const entry = this.channels.get(msg.channel);
      this.channels.delete(msg.channel);
      const err = Object.assign(new Error(msg.message), { code: msg.code, channel: msg.channel });
      for (const w of entry.waiters) w.reject(err);
      this.emit('subscription_error', { channel: msg.channel, code: msg.code, message: msg.message });
      return;
    }
    if (['auth_failed', 'token_expired', 'token_reused', 'auth_timeout'].includes(msg.code)) {
      this.emit('auth_error', { code: msg.code, message: msg.message });
      return;
    }
    this.emit('error', Object.assign(new Error(msg.message), { code: msg.code }));
  }

  onPresenceMessage(msg) {
    const members = this.presence.get(msg.channel);
    if (!members || !msg.member) return;
    if (msg.action === 'member_added') members.set(msg.member.id, msg.member);
    else if (msg.action === 'member_removed') members.delete(msg.member.id);
    else return;
    this.emitPresence({ action: msg.action, channel: msg.channel, member: msg.member });
  }

  emitPresence(change) {
    const payload = { ...change, members: this.members(change.channel) };
    for (const l of [...this.presenceListeners]) {
      if (l.channel !== change.channel) continue;
      try {
        l.callback(payload);
      } catch (err) {
        this.emit('error', err);
      }
    }
    this.emit('presence', payload);
  }

  dispatch(msg) {
    const meta = { id: msg.id, event: msg.event, channel: msg.channel, target: msg.target, sentAt: msg.sentAt };
    for (const l of [...this.listeners]) {
      if ((l.event === msg.event || l.event === '*') && (l.channel === undefined || l.channel === msg.channel)) {
        try {
          l.callback(msg.data, meta);
        } catch (err) {
          this.emit('error', err);
        }
      }
    }
  }

  onClose(ws, code, reason) {
    if (ws !== this.ws) return;
    this.detach(ws);
    this.ws = null;
    this.clearTimers();
    this.markSubscriptionsPending();

    let willReconnect = this.options.reconnect && !this.manualClose;
    if (code === CLOSE.AUTH_FAILED || code === CLOSE.AUTH_TIMEOUT) {
      this.authFailures += 1;
      if (typeof this.options.token === 'string' || this.authFailures >= this.options.maxAuthFailures) willReconnect = false;
    }
    if (code === CLOSE.DISCONNECTED && !this.options.reconnectOnServerDisconnect) willReconnect = false;

    this.emit('disconnected', { code, reason, willReconnect });
    if (willReconnect) {
      // A session expiry is routine; reconnect without backing off.
      if (code === CLOSE.SESSION_EXPIRED) this.attempt = 0;
      this.scheduleReconnect();
    } else {
      this.setState(State.DISCONNECTED);
      this.rejectConnectWaiters(Object.assign(new Error(`Connection closed (${code})`), { code }));
    }
  }

  /** Closes the current socket locally and treats it as a dropped connection. */
  dropConnection(code, reason) {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(code >= 4000 && code < 5000 ? code : 4900, reason);
    } catch {
      /* ignore */
    }
    this.onClose(ws, code, reason);
  }

  scheduleReconnect() {
    const o = this.options;
    const capped = Math.min(o.maxReconnectDelayMs, o.minReconnectDelayMs * o.reconnectFactor ** this.attempt);
    const delay = Math.round(capped / 2 + Math.random() * (capped / 2)); // "equal jitter"
    this.attempt += 1;
    this.setState(State.RECONNECTING);
    this.emit('reconnect_scheduled', { attempt: this.attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  startHeartbeat() {
    const { heartbeatIntervalMs, heartbeatTimeoutMs } = this.options;
    if (!heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > heartbeatIntervalMs + heartbeatTimeoutMs) {
        this.dropConnection(CLOSE.CLIENT_HEARTBEAT_TIMEOUT, 'heartbeat_timeout');
        return;
      }
      this.send({ type: 'ping' });
    }, heartbeatIntervalMs);
  }

  clearTimers() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  markSubscriptionsPending() {
    for (const entry of this.channels.values()) entry.confirmed = false;
  }

  rejectConnectWaiters(err) {
    for (const w of this.connectWaiters.splice(0)) w.reject(err);
  }

  watchOnline() {
    if (this.onlineHandler || typeof globalThis.addEventListener !== 'function') return;
    this.onlineHandler = () => {
      if (this.state === State.RECONNECTING && this.reconnectTimer) {
        this.attempt = 0;
        this.open();
      }
    };
    globalThis.addEventListener('online', this.onlineHandler);
  }

  setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.emit('state', { state, previous });
  }

  emit(name, payload) {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        /* a failing handler must not break the client */
      }
    }
  }
}

export default DynamicSocket;
