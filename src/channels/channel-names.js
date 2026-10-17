/**
 * Channel naming rules. Names are opaque to the server: no prefix such as
 * "private-" grants or removes privacy. Access is decided by explicit policy
 * (app `publicChannels` and token `channels` claims), see channel-authorizer.js.
 */
export const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9_\-=@,.;:]{1,128}$/;

/**
 * A channel pattern is either an exact channel name or a prefix ending in "*",
 * e.g. "orders", "user.42", "chat.room.*". A lone "*" matches every channel in
 * the application and should be used with care.
 */
export const CHANNEL_PATTERN_PATTERN = /^(?:[A-Za-z0-9_\-=@,.;:]{1,128}|[A-Za-z0-9_\-=@,.;:]{0,127}\*)$/;

export function isValidChannelName(name) {
  return typeof name === 'string' && CHANNEL_NAME_PATTERN.test(name);
}

export function isValidChannelPattern(pattern) {
  return typeof pattern === 'string' && CHANNEL_PATTERN_PATTERN.test(pattern);
}

export function channelMatches(pattern, channel) {
  if (pattern.endsWith('*')) return channel.startsWith(pattern.slice(0, -1));
  return pattern === channel;
}
