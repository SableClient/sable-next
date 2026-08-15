import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';

import { composerSchema } from './schema';

export interface ComposerMessage {
  body: string;
  formatted: string | null;
}

const markdown = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    mention: (state, node) => {
      state.text(node.attrs.name as string, false);
    },
    emoticon: (state, node) => {
      state.text(`:${node.attrs.shortcode as string}:`, false);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  }
);

function isPlain(doc: ProseMirrorNode): boolean {
  let plain = true;

  doc.descendants((node) => {
    if (!plain) return false;
    if (node.marks.length > 0) plain = false;
    else if (node.type !== composerSchema.nodes.paragraph && !node.isText) plain = false;
    return plain;
  });

  return plain;
}

function html(doc: ProseMirrorNode): string {
  const holder = document.createElement('div');
  holder.append(DOMSerializer.fromSchema(composerSchema).serializeFragment(doc.content));

  const blocks = Array.from(holder.children);
  if (blocks.length === 1 && blocks[0]?.tagName === 'P') return blocks[0].innerHTML;
  return blocks.map((block) => block.outerHTML).join('');
}

export function serializeComposer(doc: ProseMirrorNode): ComposerMessage {
  const body = markdown.serialize(doc).trim();
  if (body === '') return { body, formatted: null };

  return { body, formatted: isPlain(doc) ? null : html(doc) };
}
