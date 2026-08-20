import {
  findCategory,
  findSettingByFocusId,
  SETTINGS_DEVICES_SECTION,
} from '#lib/settings/registry.js';

export interface SettingsLink {
  section: string;
  focus?: string;
}

/** Marks a settings link from another deployment as safe to follow. Same value as v1. */
export const SETTINGS_LINK_ACTION_PARAM = 'moe.sable.client.action';
export const SETTINGS_LINK_ACTION = 'settings';

const SECTION_PATH = /\/settings\/([a-z0-9-]+)\/?$/;
const FOCUS_ID = /^[a-z0-9-]+$/;

function knownSection(section: string): boolean {
  return section === SETTINGS_DEVICES_SECTION || findCategory(section) !== undefined;
}

/** A focus id that moved to another category still resolves, as it does in v1. */
function resolve(section: string, focus: string | undefined): SettingsLink | null {
  if (focus === undefined) return knownSection(section) ? { section } : null;

  const owner = findSettingByFocusId(focus);
  if (!owner) return knownSection(section) ? { section } : null;

  return { section: owner.category.id, focus };
}

function parseQuery(params: URLSearchParams): { focus?: string; marked: boolean } | null {
  if (params.getAll('focus').length > 1) return null;
  if (params.getAll(SETTINGS_LINK_ACTION_PARAM).length > 1) return null;

  const focus = params.get('focus');
  if (focus !== null && !FOCUS_ID.test(focus)) return null;

  const action = params.get(SETTINGS_LINK_ACTION_PARAM);
  if (action !== null && action !== SETTINGS_LINK_ACTION) return null;

  return { focus: focus ?? undefined, marked: action === SETTINGS_LINK_ACTION };
}

function parsePath(pathname: string, search: string, sameOrigin: boolean): SettingsLink | null {
  const match = SECTION_PATH.exec(pathname);
  if (!match) return null;
  const section = match[1];

  const query = parseQuery(new URLSearchParams(search));
  if (!query) return null;
  // Another deployment's URL only counts when it says it is a settings link.
  if (!sameOrigin && !query.marked) return null;

  return resolve(section, query.focus);
}

/** Reads a settings link from this client, another deployment, or v1's hash routing. */
export function parseSettingsLink(href: string, origin: string): SettingsLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const sameOrigin = url.origin === origin;
  const direct = parsePath(url.pathname, url.search, sameOrigin);
  if (direct) return direct;

  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!hash) return null;
  const [hashPath = '', hashSearch = ''] = hash.split('?');
  return parsePath(hashPath, hashSearch, sameOrigin);
}

/** Always marked, so the link still resolves from another origin. */
export function buildSettingsLink(origin: string, section: string, focus?: string): string {
  const url = new URL(`/settings/${section}`, origin);
  if (focus !== undefined) url.searchParams.set('focus', focus);
  url.searchParams.set(SETTINGS_LINK_ACTION_PARAM, SETTINGS_LINK_ACTION);
  return url.toString();
}
