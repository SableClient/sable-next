import { dialog, systemPreferences, type BrowserWindow, type Session } from 'electron';
import { readFileSync } from 'node:fs';

import { writeJson } from './persistence';

const GRANTED = new Set([
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'notifications',
  'persistent-storage',
  'screen-wake-lock',
  'speaker-selection',
]);

const PROMPTS: Record<string, string> = {
  microphone: 'Sable wants to use your microphone.',
  camera: 'Sable wants to use your camera.',
  location: 'Sable wants to access your location.',
};

const systemAsks = process.platform === 'darwin';
const EMBEDDED_GRANTED = new Set(['clipboard-sanitized-write', 'fullscreen', 'screen-wake-lock']);

function embeddedOrigin(url: string): string | null {
  const parsed = URL.parse(url);
  return parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    ? parsed.origin
    : null;
}

function readGrants(path: string): string[] {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as unknown[]).filter(
      (kind): kind is string => typeof kind === 'string' && kind in PROMPTS
    );
  } catch {
    return [];
  }
}

function kindsOf(permission: string, mediaTypes: readonly string[] = []): string[] | null {
  if (permission === 'geolocation') return ['location'];
  if (permission !== 'media' || mediaTypes.length === 0) return null;
  if (mediaTypes.some((type) => type !== 'audio' && type !== 'video')) return null;
  return mediaTypes.map((type) => (type === 'audio' ? 'microphone' : 'camera'));
}

async function askSystem(kinds: string[]): Promise<boolean> {
  for (const kind of kinds) {
    if (kind !== 'microphone' && kind !== 'camera') continue;
    if (!(await systemPreferences.askForMediaAccess(kind))) return false;
  }
  return true;
}

export function enforcePermissions(
  session: Session,
  grantsPath: string,
  isAppUrl: (url: string | undefined) => boolean,
  window: () => BrowserWindow | null
): void {
  const grants = new Set(readGrants(grantsPath));
  const embeddedGrants = new Map<string, Set<string>>();
  const granted = (kinds: string[]) => kinds.every((kind) => grants.has(kind));

  async function confirm(kinds: string[], origin: string | null = null): Promise<boolean> {
    const parent = window();
    const options = {
      type: 'question' as const,
      message: origin
        ? `${origin} wants to access your ${kinds.join(' and ')}.`
        : kinds.length === 1
          ? PROMPTS[kinds[0]]
          : 'Sable wants to use your microphone and camera.',
      buttons: ['Allow', 'Deny'],
      defaultId: origin ? 1 : 0,
      cancelId: 1,
    };
    const { response } = await (parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options));
    if (response !== 0) return false;
    if (origin) {
      const allowed = embeddedGrants.get(origin) ?? new Set<string>();
      for (const kind of kinds) allowed.add(kind);
      embeddedGrants.set(origin, allowed);
      return true;
    }
    for (const kind of kinds) grants.add(kind);
    await writeJson(grantsPath, [...grants].sort());
    return true;
  }

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isAppUrl(contents.getURL())) {
      callback(false);
      return;
    }
    const app = isAppUrl(details.requestingUrl);
    const origin = app ? null : embeddedOrigin(details.requestingUrl);
    if (!app && (details.isMainFrame || !origin)) {
      callback(false);
      return;
    }
    const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined;
    if (
      securityOrigin &&
      (app ? !isAppUrl(securityOrigin) : embeddedOrigin(securityOrigin) !== origin)
    ) {
      callback(false);
      return;
    }
    if ((app ? GRANTED : EMBEDDED_GRANTED).has(permission)) {
      callback(true);
      return;
    }
    // Electron 44 reports display capture as media with no device types.
    // The display-media handler still requires a source selection.
    if (
      app &&
      permission === 'media' &&
      'mediaTypes' in details &&
      details.mediaTypes?.length === 0
    ) {
      callback(true);
      return;
    }
    const kinds = kindsOf(permission, 'mediaTypes' in details ? details.mediaTypes : undefined);
    if (!kinds) {
      callback(false);
      return;
    }
    if (!origin && systemAsks) {
      void askSystem(kinds).then(callback, () => {
        callback(false);
      });
      return;
    }
    if (origin ? kinds.every((kind) => embeddedGrants.get(origin)?.has(kind)) : granted(kinds)) {
      callback(true);
      return;
    }
    void confirm(kinds, origin).then(
      (allowed) => {
        callback(allowed && !contents.isDestroyed() && isAppUrl(contents.getURL()));
      },
      () => {
        callback(false);
      }
    );
  });

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (details.embeddingOrigin && !isAppUrl(details.embeddingOrigin)) return false;
    if (contents && !isAppUrl(contents.getURL())) return false;
    const source = details.requestingUrl ?? details.securityOrigin ?? requestingOrigin;
    const app = isAppUrl(source) && isAppUrl(requestingOrigin);
    if (
      details.securityOrigin &&
      (app
        ? !isAppUrl(details.securityOrigin)
        : embeddedOrigin(details.securityOrigin) !== embeddedOrigin(source))
    )
      return false;
    if (app && GRANTED.has(permission)) return true;
    const mediaTypes =
      details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : [];
    const kinds = kindsOf(permission, mediaTypes);
    if (app) return kinds !== null;
    const origin = embeddedOrigin(source);
    if (!contents || details.isMainFrame || !origin || embeddedOrigin(requestingOrigin) !== origin)
      return false;
    if (EMBEDDED_GRANTED.has(permission)) return true;
    return kinds?.every((kind) => embeddedGrants.get(origin)?.has(kind)) ?? false;
  });
}
