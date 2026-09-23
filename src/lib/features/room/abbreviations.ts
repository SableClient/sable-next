import type { RoomSummary } from '#src/generated/protocol';

import type { AbbreviationEntry } from './settings/abbreviations';

const MAX_SPACE_DEPTH = 4;

const SKIP_SELECTOR = 'a, abbr, code, pre, time, .code-head, [data-mx-maths], [data-mx-spoiler]';

export interface AbbreviationMatch {
  term: string;
  definition: string;
  cased: boolean;
}

export type AbbreviationMap = ReadonlyMap<string, readonly AbbreviationMatch[]>;

export function buildAbbreviationMap(
  entries: readonly AbbreviationEntry[]
): Map<string, AbbreviationMatch[]> {
  const map = new Map<string, AbbreviationMatch[]>();
  for (const entry of entries) {
    const term = entry.term.trim();
    if (term === '') continue;
    const match: AbbreviationMatch = {
      term,
      definition: entry.definition,
      cased: entry.cased === true,
    };
    const key = term.toLowerCase();
    const bucket = map.get(key);
    if (bucket) bucket.push(match);
    else map.set(key, [match]);
  }
  return map;
}

export function abbreviationPattern(map: AbbreviationMap): RegExp | null {
  if (map.size === 0) return null;

  const terms = [...map.keys()]
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${terms.join('|')})\\b`, 'gi');
}

function resolveMatch(map: AbbreviationMap, text: string): AbbreviationMatch | undefined {
  const bucket = map.get(text.toLowerCase());
  if (!bucket) return undefined;
  return (
    bucket.find((match) => match.cased && match.term === text) ??
    bucket.find((match) => !match.cased)
  );
}

export function ancestorSpaceIds(rooms: readonly RoomSummary[], roomId: string): string[] {
  const levels: string[][] = [];
  const seen = new Set([roomId]);
  let frontier = [roomId];

  for (let depth = 0; depth < MAX_SPACE_DEPTH && frontier.length > 0; depth += 1) {
    const parents = rooms.filter(
      (space) =>
        space.is_space &&
        space.state === 'joined' &&
        !seen.has(space.room_id) &&
        space.space_children.some((child) => frontier.includes(child.room_id))
    );
    for (const parent of parents) seen.add(parent.room_id);
    frontier = parents.map((parent) => parent.room_id);
    if (frontier.length > 0) levels.push(frontier);
  }

  return levels.slice().reverse().flat();
}

export function markAbbreviations(root: HTMLElement, map: AbbreviationMap, pattern: RegExp): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.trim() === '' || node.parentElement?.closest(SKIP_SELECTOR)) continue;
    texts.push(node);
  }

  for (const node of texts) {
    const marked = markText(node.data, map, pattern);
    if (marked) node.replaceWith(marked);
  }
}

function markText(text: string, map: AbbreviationMap, pattern: RegExp): DocumentFragment | null {
  const fragment = document.createDocumentFragment();
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const resolved = resolveMatch(map, match[0]);
    if (resolved === undefined) continue;

    if (match.index > last) fragment.append(text.slice(last, match.index));
    const abbr = document.createElement('abbr');
    abbr.dataset.abbrDefinition = resolved.definition;
    abbr.tabIndex = 0;
    abbr.textContent = match[0];
    fragment.append(abbr);
    last = match.index + match[0].length;
  }

  if (last === 0) return null;
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}
