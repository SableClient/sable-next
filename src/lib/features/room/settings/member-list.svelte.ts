export const MEMBER_LIST_EVENT_TYPE = 'moe.sable.room.member_list';

export const memberListChanges = $state({ version: 0 });

export function memberListChanged(): void {
  memberListChanges.version += 1;
}

export function readAlwaysListedFrom(content: unknown): number | null {
  if (typeof content !== 'object' || content === null) return null;
  const level = (content as { always_listed_from?: unknown }).always_listed_from;
  return typeof level === 'number' && Number.isSafeInteger(level) ? level : null;
}
