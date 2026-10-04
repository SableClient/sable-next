import { InputRule } from 'prosemirror-inputrules';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import type { PackImageView } from '#src/generated/protocol';

import { emojiForShortcode } from '#lib/emoji/emoji.js';

import { composerSchema } from './schema';

const pattern = /(?<![^\s\uFFFC]):([^\s:\uFFFC]{1,100}):$/u;

export function emoticonNode(image: PackImageView): ProseMirrorNode {
  return composerSchema.nodes.emoticon.create({
    url: image.url,
    body: image.body,
    shortcode: image.shortcode,
    sourcePack: image.source_pack,
  });
}

export function shortcodeNode(
  shortcode: string,
  emotes: readonly PackImageView[]
): ProseMirrorNode | null {
  const matches = emotes.filter((candidate) => candidate.shortcode === shortcode);
  if (matches.length > 1) return null;
  const image = matches.at(0);
  if (image) return emoticonNode(image);

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
