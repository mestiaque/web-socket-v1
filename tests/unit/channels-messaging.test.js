import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelMatches, isValidChannelName, isValidChannelPattern } from '../../src/channels/channel-names.js';
import { authorizeSubscription } from '../../src/channels/channel-authorizer.js';
import { ChannelManager } from '../../src/channels/channel-manager.js';
import { validatePublishRequest } from '../../src/messaging/event-validator.js';
import { parseClientMessage, serializeEvent } from '../../src/messaging/serializer.js';
import { Broadcaster } from '../../src/messaging/broadcaster.js';
import { Metrics } from '../../src/observability/metrics.js';
import { ErrorCode } from '../../src/utils/errors.js';

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'no error';
};
const conn = (appId, sub, channels = [], publicChannels = []) => ({
  appId,
  sub,
  app: { publicChannels },
  claims: { channels },
  channels: new Set(),
});

test('channel names and patterns', () => {
  for (const ok of ['orders', 'private-user.42', 'chat.room:7', 'a=b@c,d;e']) assert.ok(isValidChannelName(ok), ok);
  for (const bad of ['', 'has space', 'x'.repeat(129), 'emoji😀', 'star*', null, 5]) assert.ok(!isValidChannelName(bad), String(bad));
  assert.ok(isValidChannelPattern('chat.room.*'));
  assert.ok(isValidChannelPattern('*'));
  assert.ok(!isValidChannelPattern('a*b'));
  assert.ok(channelMatches('chat.room.*', 'chat.room.7'));
  assert.ok(!channelMatches('chat.room.*', 'chat.roomX'));
  assert.ok(channelMatches('orders', 'orders'));
  assert.ok(!channelMatches('orders', 'orders2'));
});

test('authorization is explicit; "private-" prefix means nothing', () => {
  const app = { publicChannels: ['status.*'] };
  assert.equal(authorizeSubscription(app, { channels: [] }, 'status.db'), 'public');
  assert.equal(authorizeSubscription(app, { channels: ['private-x'] }, 'private-x'), 'granted');
  assert.equal(authorizeSubscription(app, { channels: [] }, 'private-x'), null);
  assert.equal(authorizeSubscription(app, { channels: [] }, 'orders'), null);
});

test('channel manager isolates apps, enforces limits, cleans up', () => {
  const manager = new ChannelManager({ maxSubscriptionsPerConnection: 2 });
  const a = conn('A', '1', ['orders', 'x', 'y']);
  const b = conn('B', '1', ['orders']);
  manager.registerUser(a);
  manager.registerUser(b);
  manager.subscribe(a, 'orders');
  manager.subscribe(b, 'orders');
  assert.equal(manager.subscribe(a, 'orders').alreadySubscribed, true);
  assert.deepEqual([...manager.registry.subscribers('A', 'orders')], [a]);
  assert.deepEqual([...manager.registry.subscribers('B', 'orders')], [b]);
  assert.deepEqual([...manager.registry.userConnections('A', '1')], [a]);

  assert.equal(code(() => manager.subscribe(a, 'nope')), ErrorCode.FORBIDDEN);
  assert.equal(code(() => manager.subscribe(a, 'bad name')), ErrorCode.INVALID_CHANNEL);
  manager.subscribe(a, 'x');
  assert.equal(code(() => manager.subscribe(a, 'y')), ErrorCode.SUBSCRIPTION_LIMIT);

  assert.equal(manager.unsubscribe(a, 'x'), true);
  assert.equal(manager.unsubscribe(a, 'x'), false);
  manager.removeConnection(a);
  assert.equal(manager.registry.subscribers('A', 'orders').size, 0);
  assert.equal(manager.registry.userConnections('A', '1').size, 0);
  assert.deepEqual(manager.registry.stats(), { channels: 1, users: 1, subscriptions: 1 });
});

test('publish validation', () => {
  const v = (body) => validatePublishRequest(body, { maxTargets: 3 });
  assert.deepEqual(v({ channel: 'orders', event: 'order.created', data: { id: 1 } }), {
    channels: ['orders'],
    users: [],
    event: 'order.created',
    data: { id: 1 },
    id: undefined,
  });
  assert.deepEqual(v({ users: [42, '42', 'u'], event: 'App\\Events\\Ping' }).users, ['42', 'u']);
  assert.equal(v({ channels: ['a', 'a'], event: 'e' }).channels.length, 1);
  assert.equal(code(() => v(null)), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v([])), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ event: 'e' })), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ channel: 'a', channels: ['b'], event: 'e' })), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ channel: 'a', event: 'e', extra: 1 })), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ channel: 'bad name', event: 'e' })), ErrorCode.INVALID_CHANNEL);
  assert.equal(code(() => v({ channel: 'a', event: 'has space' })), ErrorCode.INVALID_EVENT);
  assert.equal(code(() => v({ channel: 'a', event: '' })), ErrorCode.INVALID_EVENT);
  assert.equal(code(() => v({ channels: ['a', 'b', 'c'], users: ['1'], event: 'e' })), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ users: [''], event: 'e' })), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => v({ channel: 'a', event: 'e', id: 'bad id' })), ErrorCode.BAD_MESSAGE);
});

test('client message parsing never executes content', () => {
  assert.deepEqual(parseClientMessage(Buffer.from('{"type":"ping"}'), false), { type: 'ping' });
  assert.equal(code(() => parseClientMessage(Buffer.from('{nope'), false)), ErrorCode.BAD_JSON);
  assert.equal(code(() => parseClientMessage(Buffer.from('[1]'), false)), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => parseClientMessage(Buffer.from('{"type":1}'), false)), ErrorCode.BAD_MESSAGE);
  assert.equal(code(() => parseClientMessage(Buffer.from('{}'), true)), ErrorCode.BAD_MESSAGE);
  const proto = parseClientMessage(Buffer.from('{"type":"x","__proto__":{"polluted":true}}'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(proto.type, 'x');
  assert.equal(JSON.parse(serializeEvent({ id: '1', target: 'user', event: 'e', data: null, sentAt: 't' })).channel, null);
});

test('broadcaster drops frames and closes slow consumers over the buffer limit', () => {
  const manager = new ChannelManager({ maxSubscriptionsPerConnection: 10 });
  const sent = [];
  const make = (bufferedAmount) => {
    const c = conn('A', '1', ['orders']);
    c.ws = { bufferedAmount, send: (frame) => sent.push(frame.toString()) };
    c.isOpen = () => true;
    c.slowClosed = 0;
    c.closeSlowConsumer = () => {
      c.slowClosed += 1;
    };
    manager.subscribe(c, 'orders');
    return c;
  };
  const fast = make(0);
  const slow = make(1000);
  const metrics = new Metrics();
  const b = new Broadcaster({ registry: manager.registry, maxBufferedBytes: 1024, metrics, logger: null });
  const report = b.deliver({ id: 'm1', appId: 'A', channels: ['orders'], users: [], event: 'e', data: { x: 1 }, sentAt: 't' });
  assert.deepEqual(report, { recipients: 2, sent: 1, dropped: 1 });
  assert.equal(slow.slowClosed, 1);
  assert.equal(fast.slowClosed, 0);
  assert.equal(JSON.parse(sent[0]).channel, 'orders');
  assert.equal(metrics.get('ds_frames_dropped_total', { app: 'A' }), 1);
});
