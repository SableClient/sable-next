// @vitest-environment happy-dom

import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { expect, test } from 'vitest';

import type { ComposerPill } from '#src/generated/protocol';

import corpus from '../../../../../crates/sable-model/fixtures/markdown.json' with { type: 'json' };

import { composerSchema } from './schema';
import { serializePlain, textDoc } from './serialize';

function pillNode(pill: ComposerPill): ProseMirrorNode {
  return pill.kind === 'mention'
    ? composerSchema.nodes.mention.create({ userId: pill.user_id, name: pill.name, via: pill.via })
    : composerSchema.nodes.emoticon.create({
        url: pill.url,
        shortcode: pill.shortcode,
        body: pill.body,
      });
}

/** The typed text with each `￼` replaced by the next pill, as the composer holds it. */
function typed(markdown: string, pills: ComposerPill[]): ProseMirrorNode {
  const queue = [...pills];
  const doc = textDoc(markdown);
  const blocks: ProseMirrorNode[] = [];
  doc.forEach((block) => {
    const children: ProseMirrorNode[] = [];
    block.forEach((child) => {
      if (!child.isText) {
        children.push(child);
        return;
      }
      for (const [index, part] of (child.text ?? '').split('￼').entries()) {
        const pill = index > 0 ? queue.shift() : undefined;
        if (pill) children.push(pillNode(pill));
        if (part !== '') children.push(composerSchema.text(part));
      }
    });
    blocks.push(block.copy(Fragment.fromArray(children)));
  });
  return doc.copy(Fragment.fromArray(blocks));
}

test.each(corpus)('plain mode sends $markdown as the corpus says', (entry) => {
  const message = serializePlain(typed(entry.markdown, entry.pills as ComposerPill[]));

  expect({
    body: message.body,
    formatted_body: message.formatted,
    mentions: { user_ids: message.mentions.user_ids, room: message.mentions.room },
  }).toEqual({
    body: entry.body,
    formatted_body: entry.formatted_body,
    mentions: entry.mentions,
  });
});
