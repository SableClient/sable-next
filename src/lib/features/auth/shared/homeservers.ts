export const HOMESERVERS = [
  'matrix.org',
  'mozilla.org',
  'unredacted.org',
  'sable.moe',
  'kendama.moe',
] as const;

export const DEFAULT_HOMESERVER = HOMESERVERS[0];
export const HOMESERVER_ITEMS = HOMESERVERS.map((value) => ({ value, label: value }));
