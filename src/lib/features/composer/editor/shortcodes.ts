import { InputRule } from 'prosemirror-inputrules';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import type { PackImageView } from '#src/generated/PackImageView';

import { emojiForShortcode } from '#lib/emoji/emoji.js';

import { composerSchema } from './schema';

const pattern = /(?<![^\s\uFFFC]):([^\s:\uFFFC]{1,32}):$/u;

export function shortcodeNode(
  shortcode: string,
  emotes: readonly PackImageView[]
): ProseMirrorNode | null {
  const image = emotes.find((candidate) => candidate.shortcode === shortcode);
  if (image) return composerSchema.nodes.emoticon.create({ url: image.url, shortcode });

  const emoji = emojiForShortcode(shortcode);
  return emoji ? composerSchema.text(emoji) : null;
}

export function shortcodeInputRule(emotes: () => readonly PackImageView[]): InputRule {
  return new InputRule(
    pattern,
    (state, match, start, end) => {
      const node = shortcodeNode(match[1], emotes());
      return node ? state.tr.replaceWith(start, end, node) : null;
    },
    { inCodeMark: false }
  );
}
