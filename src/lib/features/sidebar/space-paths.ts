import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-space-paths';

export const HOME_PATHS_KEY = 'home';
export const ROOMS_PATHS_KEY = 'rooms';
export const DIRECT_PATHS_KEY = 'direct';

type SpacePaths = Record<string, string>;

function parse(value: unknown): SpacePaths {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export function savedSpacePaths(): SpacePaths {
  return readJson(STORAGE_KEY, parse, {});
}

export function saveSpacePath(spaceId: string, path: string): void {
  writeJson(
    STORAGE_KEY,
    { ...savedSpacePaths(), [spaceId]: path },
    '[sable nav] space path not persisted'
  );
}

export function spaceNavigationHref(
  root: string,
  savedPath: string | undefined,
  fallback: string
): string {
  if (!savedPath || (savedPath !== root && !savedPath.startsWith(`${root}/`))) {
    return fallback;
  }

  return savedPath;
}

const SPACE_PAGES = new Set(['create-room', 'create-space']);

function segmentUnder(root: string, path: string): string | null {
  if (!path.startsWith(`${root}/`)) return null;
  return path.slice(root.length + 1).split(/[/?#]/, 1)[0];
}

export function isJoinedRoomPath(
  root: string,
  path: string,
  isJoinedRoom: (pathId: string) => boolean
): boolean {
  const segment = segmentUnder(root, path);
  if (segment === null || segment === '' || segment === 'lobby' || SPACE_PAGES.has(segment)) {
    return false;
  }
  try {
    return isJoinedRoom(decodeURIComponent(segment));
  } catch {
    return false;
  }
}

export function spaceIndexRedirect(
  root: string,
  savedPath: string | undefined,
  lobby: string,
  isJoinedRoom: (pathId: string) => boolean
): string {
  if (savedPath === undefined) return lobby;
  if (segmentUnder(root, savedPath) === 'lobby') return savedPath;
  return isJoinedRoomPath(root, savedPath, isJoinedRoom) ? savedPath : lobby;
}
