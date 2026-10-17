import { channelMatches } from './channel-names.js';

/**
 * Presence (online/offline) tracking for presence channels.
 *
 * A channel is a presence channel only if it matches one of the app's
 * `presenceChannels` patterns; names carry no meaning. Who may subscribe is
 * still decided by the normal channel authorization.
 *
 * Members are identified by the token `sub`. Several connections of the same
 * user (tabs, devices) form ONE member. `member_added` is sent when a user's
 * first connection joins; `member_removed` when the last one leaves and has
 * not come back within `leaveGraceMs` (so a page reload does not flicker the
 * user offline and online again). During the grace period the user is still
 * listed as a member.
 *
 * State is per process and in memory, like all subscription state.
 */
const SEP = '\u0000';

export class PresenceManager {
  /**
   * @param {{ maxMembers: number, leaveGraceMs: number,
   *           notify: (appId: string, channel: string, message: object, excludeSub: string) => void }} opts
   */
  constructor({ maxMembers, leaveGraceMs, notify }) {
    this.maxMembers = maxMembers;
    this.leaveGraceMs = leaveGraceMs;
    this.notify = notify;
    this.channels = new Map(); // appId SEP channel -> Map<sub, { id, info, conns: Set, timer }>
  }

  isPresenceChannel(app, channel) {
    return (app.presenceChannels ?? []).some((pattern) => channelMatches(pattern, channel));
  }

  /** False when the channel is full and this user is not already a member. */
  canJoin(conn, channel) {
    const members = this.channels.get(key(conn.appId, channel));
    if (!members || members.has(conn.sub)) return true;
    return members.size < this.maxMembers;
  }

  /** Adds the connection; returns the member snapshot (including the joiner). */
  join(conn, channel) {
    const k = key(conn.appId, channel);
    let members = this.channels.get(k);
    if (!members) {
      members = new Map();
      this.channels.set(k, members);
    }
    let member = members.get(conn.sub);
    if (member) {
      member.conns.add(conn);
      member.info = conn.userInfo ?? member.info;
      if (member.timer) {
        // Came back within the grace period: no events, nothing changed for others.
        clearTimeout(member.timer);
        member.timer = null;
      }
    } else {
      member = { id: conn.sub, info: conn.userInfo ?? null, conns: new Set([conn]), timer: null };
      members.set(conn.sub, member);
      this.notify(conn.appId, channel, { type: 'presence', action: 'member_added', channel, member: publicMember(member) }, conn.sub);
    }
    return this.snapshot(conn.appId, channel);
  }

  leave(conn, channel) {
    const k = key(conn.appId, channel);
    const members = this.channels.get(k);
    const member = members?.get(conn.sub);
    if (!member || !member.conns.delete(conn) || member.conns.size > 0) return;

    const remove = () => {
      member.timer = null;
      if (member.conns.size > 0 || members.get(member.id) !== member) return;
      members.delete(member.id);
      if (members.size === 0) this.channels.delete(k);
      this.notify(conn.appId, channel, { type: 'presence', action: 'member_removed', channel, member: { id: member.id } }, member.id);
    };
    if (this.leaveGraceMs > 0) {
      member.timer = setTimeout(remove, this.leaveGraceMs);
      member.timer.unref?.();
    } else {
      remove();
    }
  }

  snapshot(appId, channel) {
    const members = this.channels.get(key(appId, channel));
    const list = members ? [...members.values()].map(publicMember) : [];
    return { count: list.length, members: list };
  }

  /** Cancels pending removals (used on shutdown). */
  dispose() {
    for (const members of this.channels.values()) {
      for (const member of members.values()) clearTimeout(member.timer);
    }
    this.channels.clear();
  }
}

function key(appId, channel) {
  return `${appId}${SEP}${channel}`;
}

function publicMember(member) {
  return { id: member.id, info: member.info };
}
