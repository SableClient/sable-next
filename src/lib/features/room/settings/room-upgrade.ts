const NO_ADDITIONAL_CREATORS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);

export function additionalCreatorsSupported(version: string): boolean {
  return version !== '' && !NO_ADDITIONAL_CREATORS.has(version);
}

export function readCreate(content: unknown): { version: string; predecessor: string | null } {
  if (typeof content !== 'object' || content === null) {
    return { version: '1', predecessor: null };
  }

  const create = content as { room_version?: unknown; predecessor?: { room_id?: unknown } };
  return {
    version: typeof create.room_version === 'string' ? create.room_version : '1',
    predecessor:
      typeof create.predecessor?.room_id === 'string' ? create.predecessor.room_id : null,
  };
}

export function readTombstone(content: unknown): {
  replacement: string | null;
  body: string | null;
} {
  if (typeof content !== 'object' || content === null) {
    return { replacement: null, body: null };
  }

  const tombstone = content as { replacement_room?: unknown; body?: unknown };
  return {
    replacement: typeof tombstone.replacement_room === 'string' ? tombstone.replacement_room : null,
    body: typeof tombstone.body === 'string' && tombstone.body !== '' ? tombstone.body : null,
  };
}
