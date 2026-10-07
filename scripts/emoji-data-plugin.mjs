import compact from 'emojibase-data/en/compact.json' with { type: 'json' };
import emojibaseShortcodes from 'emojibase-data/en/shortcodes/emojibase.json' with { type: 'json' };
import joypixelsShortcodes from 'emojibase-data/en/shortcodes/joypixels.json' with { type: 'json' };

import { emojiGroupOrder } from '../src/lib/emoji/emoji-groups.ts';

const virtualId = 'virtual:sable-emoji-data';
const resolvedId = `\0${virtualId}`;

// Skip group 2: components such as skin tones.
/** @type {Partial<Record<number, import('../src/lib/emoji/emoji-groups.ts').EmojiGroupId>>} */
const groupOf = {
  0: 'people',
  1: 'people',
  3: 'nature',
  4: 'food',
  5: 'travel',
  6: 'activity',
  7: 'object',
  8: 'symbol',
  9: 'flag',
};

function compileEmojiData() {
  const records = [];

  for (const entry of compact) {
    const groupId = groupOf[entry.group ?? 8];
    if (groupId === undefined) continue;

    const codes = [];
    for (const map of [joypixelsShortcodes, emojibaseShortcodes]) {
      const code = map[entry.hexcode];
      if (typeof code === 'string') codes.push(code);
      else if (Array.isArray(code)) codes.push(...code);
    }
    if (!codes[0]) continue;

    const groupIndex = emojiGroupOrder.indexOf(groupId);
    if (groupIndex === -1) throw new Error(`Unknown emoji group: ${groupId}`);

    const keywords = [...new Set([...codes.slice(1), ...entry.label.toLowerCase().split(/\s+/)])];
    records.push([entry.unicode, codes, keywords, groupIndex]);
  }

  return `export const emojiRawRecords = ${JSON.stringify(records)};`;
}

/** @returns {import('vite').Plugin} */
export function emojiDataPlugin() {
  return {
    name: 'sable-emoji-data',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId) return compileEmojiData();
    },
  };
}
