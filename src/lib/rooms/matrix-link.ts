import type { MatrixLink } from '#src/generated/protocol';

import { parseMatrixLink as parseLink } from '#lib/model/model.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

export type { MatrixLink };

export const MATRIX_TO = 'https://matrix.to/#/';
const SABLE_LINK = 'https://link.sable.moe/#/';

function customLinkHost(value: string): string | null {
  try {
    return new URL(`https://${value.trim().replace(/^https?:\/\//i, '')}`).host || null;
  } catch {
    return null;
  }
}

export function matrixLinkHost(): string {
  switch (preferences.matrixLinkSelector) {
    case 'sable':
      return 'link.sable.moe';
    case 'custom':
      return customLinkHost(preferences.matrixLinkCustom) ?? 'matrix.to';
    default:
      return 'matrix.to';
  }
}

/** Every host the app reads as a Matrix link, including the one it writes links with. */
export function knownLinkPrefixes(): string[] {
  return [...new Set([MATRIX_TO, SABLE_LINK, `https://${matrixLinkHost()}/#/`])];
}

export function parseMatrixLink(href: string): MatrixLink | null {
  return parseLink(href, matrixLinkHost());
}

export function matrixLinkDestination(link: MatrixLink): string {
  if (link.kind === 'user') return link.user_id;
  if (link.kind === 'room') return link.room_id;
  return `${link.room_id}/${link.event_id}`;
}

/** matrix.to queries live inside the fragment; matrix: queries precede it. */
export function matrixLinkParameters(href: string): URLSearchParams {
  const resource = /^matrix:/i.test(href)
    ? (href.split('#', 1)[0] ?? '')
    : href.slice(href.indexOf('#') + 1);
  const query = resource.indexOf('?');
  return new URLSearchParams(query < 0 ? '' : resource.slice(query + 1).replaceAll('+', '%2B'));
}

export function matrixLinkAction(href: string, link: MatrixLink): 'join' | 'chat' | null {
  const action = matrixLinkParameters(href).get('action');
  if (action === 'join' && link.kind === 'room') return action;
  if (action === 'chat' && link.kind === 'user') return action;
  return null;
}
