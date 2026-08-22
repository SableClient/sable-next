import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';

import type { OutgoingMentions } from '#lib/core/client.svelte.js';

import { composerSchema } from './schema';

export interface ComposerMessage {
  body: string;
  formatted: string | null;
  mentions: OutgoingMentions;
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
  const mentions = mentionsOf(doc, body);
  if (body === '') return { body, formatted: null, mentions };

  return { body, formatted: isPlain(doc) ? null : html(doc), mentions };
}

export function mentionsOf(doc: ProseMirrorNode, body: string): OutgoingMentions {
  const userIds = new Set<string>();

  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.mention) return true;
    const userId = node.attrs.userId as string;
    if (userId.startsWith('@')) userIds.add(userId);
    return false;
  });

  return { userIds: [...userIds], room: /(^|\s)@room(\s|$)/.test(body) };
}
