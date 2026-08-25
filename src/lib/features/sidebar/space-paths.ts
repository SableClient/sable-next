const STORAGE_KEY = 'sable-space-paths';

type SpacePaths = Record<string, string>;

function load(): SpacePaths {
  if (typeof localStorage === 'undefined') return {};

  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return {};
  }
}

export function savedSpacePaths(): SpacePaths {
  return load();
}

export function saveSpacePath(spaceId: string, path: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [spaceId]: path }));
  } catch (error) {
    console.debug('[sable nav] space path not persisted', error);
  }
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
