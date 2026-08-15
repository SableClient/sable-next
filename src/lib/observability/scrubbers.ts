// No Sentry imports, so these stay testable without the init side effects.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'tauri.localhost']);

if (typeof window !== 'undefined') {
  try {
    const appHost = new URL(window.location.origin).hostname.toLowerCase();
    if (appHost) LOCAL_HOSTS.add(appHost);
  } catch {
    // An opaque origin has no hostname to preserve.
  }
}

export function scrubExternalHosts(value: string): string {
  return value.replace(/\bhttps?:\/\/[^/?#\s]+/gi, (match) => {
    const schemeEnd = match.indexOf('://') + 3;
    const hostname = (match.slice(schemeEnd).split(':')[0] ?? '').toLowerCase();
    if (LOCAL_HOSTS.has(hostname)) return match;
    return `${match.slice(0, schemeEnd)}[HOMESERVER]`;
  });
}

export function scrubMatrixIds(value: string): string {
  return scrubExternalHosts(value)
    .replace(
      /(access_token|password|token|refresh_token|session_id|sync_token|next_batch)([=:\s]+)([^\s&]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/@[^\s:@]+:[^\s,'"(){}[\]]+/g, '@[USER_ID]')
    .replace(/![^\s:]+:[^\s,'"(){}[\]]+/g, '![ROOM_ID]')
    .replace(/#[^\s:@]+:[^\s,'"(){}[\]]+/g, '#[ROOM_ALIAS]')
    .replace(/\$[A-Za-z0-9_+/-]{10,}/g, '$[EVENT_ID]');
}

export function scrubDataObject(data: unknown): unknown {
  if (typeof data === 'string') return scrubMatrixIds(data);
  if (Array.isArray(data)) return data.map(scrubDataObject);
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        scrubDataObject(value),
      ])
    );
  }
  return data;
}

const IDENTIFIER_KEYS = new Set([
  'roomId',
  'eventId',
  'userId',
  'senderId',
  'targetEventId',
  'deviceId',
  'spaceId',
  'threadRootId',
  'transactionId',
]);

export function omitIdentifierFields(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(omitIdentifierFields);
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>)
        .filter(([key]) => !IDENTIFIER_KEYS.has(key))
        .map(([key, value]) => [key, omitIdentifierFields(value)])
    );
  }
  return data;
}

export function sanitizePayload(data: unknown): unknown {
  return scrubDataObject(omitIdentifierFields(data));
}

export function scrubMatrixUrl(url: string): string {
  return (
    scrubExternalHosts(url)
      .replace(/\/rooms\/![^/?#\s]*/g, '/rooms/![ROOM_ID]')
      .replace(/\/event\/(?:\$|%24)[^/?#\s]*/g, '/event/$[EVENT_ID]')
      .replace(/\/relations\/(?:\$|%24)[^/?#\s]*/g, '/relations/$[EVENT_ID]')
      .replace(/\/profile\/(?:%40|@)[^/?#\s]*/gi, '/profile/[USER_ID]')
      .replace(/\/(user|presence)\/(?:%40|@)[^/?#\s]*/gi, '/$1/[USER_ID]')
      .replace(/\/room_keys\/keys\/[^/?#\s]*/gi, '/room_keys/keys/[REDACTED]')
      .replace(/\/sendToDevice\/([^/?#\s]+)\/[^/?#\s]+/gi, '/sendToDevice/$1/[TXN_ID]')
      .replace(
        /(\/media\/(?:thumbnail|download)\/)(?:[^/?#\s]+)\/(?:[^/?#\s]+)/gi,
        '$1[SERVER]/[MEDIA_ID]'
      )
      .replace(
        /(\/media\/v\d+\/(?:thumbnail|download)\/)(?:[^/?#\s]+)\/(?:[^/?#\s]+)/gi,
        '$1[SERVER]/[MEDIA_ID]'
      )
      // Browsers decode %21 and %40 for display but often leave %3A encoded,
      // so both the literal colon and the encoding have to match.
      .replace(/\/![^/?#\s:%]+(?:%3A|:)[^/?#\s]*/gi, '/![ROOM_ID]')
      .replace(/\/@[^/?#\s:%]+(?:%3A|:)[^/?#\s]*/gi, '/@[USER_ID]')
      .replace(/\/#[^/?#\s:%]+(?:%3A|:)[^/?#\s]*/gi, '/[ROOM_ALIAS]')
      .replace(/\/%40[^/?#\s]*/gi, '/[USER_ID]')
      .replace(/\/%21[^/?#\s]*/gi, '/![ROOM_ID]')
      .replace(/\/%23[^/?#\s]*/gi, '/[ROOM_ALIAS]')
      .replace(/\/%24[^/?#\s]*/gi, '/[EVENT_ID]')
      // Sigil-less IDs that still follow localpart%3Aserver, e.g. device IDs.
      .replace(/\/[A-Za-z0-9+_-]{5,}%3A[A-Za-z0-9._-]+[^/?#\s]*/gi, '/[MATRIX_ID]')
      // Runs last so the patterns above claim the IDs they recognise.
      .replace(/\/[A-Za-z0-9+_-]{30,}(\/|$)/g, '/[REDACTED]$1')
      .replace(/(\/preview_url)\?[^#\s]*/gi, '$1')
      .replace(/([?&#](?:code|state|loginToken)=)[^&#\s]+/gi, '$1[REDACTED]')
  );
}
