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

export function readFounders(event: unknown): string[] {
  if (typeof event !== 'object' || event === null) return [];

  const create = event as { sender?: unknown; content?: unknown };
  const content = (
    typeof create.content === 'object' && create.content !== null ? create.content : {}
  ) as { room_version?: unknown; additional_creators?: unknown };
  const version = typeof content.room_version === 'string' ? content.room_version : '1';
  if (!additionalCreatorsSupported(version) || typeof create.sender !== 'string') return [];

  const additional = Array.isArray(content.additional_creators)
    ? content.additional_creators.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return [...new Set([create.sender, ...additional])];
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
