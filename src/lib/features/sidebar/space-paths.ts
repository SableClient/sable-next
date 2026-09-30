import { readJson, writeJson } from '#lib/platform/local-json.js';

const STORAGE_KEY = 'sable-space-paths';

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
  mobile: boolean,
  fallback: string
): string {
  if (mobile) return root;
  if (!savedPath || (savedPath !== root && !savedPath.startsWith(`${root}/`))) {
    return fallback;
  }

  return savedPath;
}

const SPACE_PAGES = new Set(['create-room', 'create-space']);

export function spaceIndexRedirect(
  root: string,
  savedPath: string | undefined,
  lobby: string,
  isJoinedRoom: (pathId: string) => boolean
): string {
  if (!savedPath?.startsWith(`${root}/`)) return lobby;

  const segment = savedPath.slice(root.length + 1).split(/[/?#]/, 1)[0];
  if (segment === 'lobby') return savedPath;
  if (segment === '' || SPACE_PAGES.has(segment)) return lobby;

  let pathId: string;
  try {
    pathId = decodeURIComponent(segment);
  } catch {
    return lobby;
  }

  return isJoinedRoom(pathId) ? savedPath : lobby;
}
