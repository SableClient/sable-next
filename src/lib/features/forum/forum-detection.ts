export const FORUM_ROOM_TYPE = 'pl.chrome.forum';

export function isForumRoomType(createContent: unknown): boolean {
  if (typeof createContent !== 'object' || createContent === null) return false;
  const type = (createContent as { type?: unknown }).type;
  return type === FORUM_ROOM_TYPE;
}
