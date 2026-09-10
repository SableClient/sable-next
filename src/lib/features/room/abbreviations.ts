import type { RoomSummary } from '#src/generated/protocol';

import type { AbbreviationEntry } from './settings/abbreviations';

const MAX_SPACE_DEPTH = 4;

const SKIP_SELECTOR = 'a, abbr, code, pre, [data-mx-maths], [data-mx-spoiler]';

export function buildAbbreviationMap(entries: readonly AbbreviationEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.term.trim().toLowerCase();
    if (key !== '') map.set(key, entry.definition);
  }
  return map;
}

export function abbreviationPattern(map: ReadonlyMap<string, string>): RegExp | null {
  if (map.size === 0) return null;

  const terms = [...map.keys()]
    .toSorted((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${terms.join('|')})\\b`, 'gi');
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

  return levels.toReversed().flat();
}

export function markAbbreviations(
  root: HTMLElement,
  map: ReadonlyMap<string, string>,
  pattern: RegExp
): void {
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

function markText(
  text: string,
  map: ReadonlyMap<string, string>,
  pattern: RegExp
): DocumentFragment | null {
  const fragment = document.createDocumentFragment();
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const definition = map.get(match[0].toLowerCase());
    if (definition === undefined) continue;

    if (match.index > last) fragment.append(text.slice(last, match.index));
    const abbr = document.createElement('abbr');
    abbr.dataset.abbrDefinition = definition;
    abbr.tabIndex = 0;
    abbr.textContent = match[0];
    fragment.append(abbr);
    last = match.index + match[0].length;
  }

  if (last === 0) return null;
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}
