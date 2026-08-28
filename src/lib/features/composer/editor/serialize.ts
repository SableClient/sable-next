import MarkdownIt from 'markdown-it';
import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type ParseSpec,
} from 'prosemirror-markdown';
import { DOMSerializer, Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';

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
    /* The default writes markdown's `\\` hard-break escape, which shows up as
       a stray backslash in clients that only render the plain body. */
    hard_break: (state, node, parent, index) => {
      for (let i = index + 1; i < parent.childCount; i += 1) {
        if (parent.child(i).type !== node.type) {
          state.write('\n');
          return;
        }
      }
    },
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
    underline: { open: '', close: '', mixable: true },
    spoiler: { open: '||', close: '||', mixable: true, expelEnclosingWhitespace: true },
  }
);

function isPlain(doc: ProseMirrorNode): boolean {
  const { paragraph, hard_break: hardBreak } = composerSchema.nodes;
  let plain = true;

  doc.descendants((node) => {
    if (!plain) return false;
    if (node.marks.length > 0) plain = false;
    else if (node.type !== paragraph && node.type !== hardBreak && !node.isText) plain = false;
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
  const mentions = mentionsOf(doc);
  if (body === '') return { body, formatted: null, mentions };

  return { body, formatted: isPlain(doc) ? null : html(doc), mentions };
}

function mentionsRoom(doc: ProseMirrorNode): boolean {
  let found = false;

  doc.descendants((node) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    if (node.type === composerSchema.nodes.code_block) return false;

    let text = '';
    node.forEach((child) => {
      const quoted = !child.isText || composerSchema.marks.code.isInSet(child.marks);
      text += quoted ? ' ' : (child.text ?? '');
    });
    if (/(^|\s)@room(\s|$)/.test(text)) found = true;
    return false;
  });

  return found;
}

export function mentionsOf(doc: ProseMirrorNode): OutgoingMentions {
  const userIds = new Set<string>();

  doc.descendants((node) => {
    if (node.type !== composerSchema.nodes.mention) return true;
    const userId = node.attrs.userId as string;
    if (userId.startsWith('@')) userIds.add(userId);
    return false;
  });

  return { userIds: [...userIds], room: mentionsRoom(doc) };
}

/* `commonmark` leaves strikethrough off, and the composer schema has no image
   or horizontal rule, so this needs its own tokenizer rather than the shared
   `defaultMarkdownParser`'s. */
const tokenizer = MarkdownIt('commonmark', { html: false }).enable('strikethrough');

const PARSE_TOKENS: Record<string, ParseSpec> = {
  paragraph: { block: 'paragraph' },
  blockquote: { block: 'blockquote' },
  list_item: { block: 'list_item' },
  bullet_list: { block: 'bullet_list' },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (token) => ({ order: Number(token.attrGet('start') ?? '1') || 1 }),
  },
  heading: {
    block: 'heading',
    getAttrs: (token) => ({ level: Math.min(3, Number(token.tag.slice(1))) }),
  },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: { block: 'code_block', noCloseToken: true },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'hard_break' },
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike' },
  code_inline: { mark: 'code', noCloseToken: true },
  link: { mark: 'link', getAttrs: (token) => ({ href: token.attrGet('href') ?? '' }) },
  hr: { ignore: true },
  image: { ignore: true },
};

const markdownParser = new MarkdownParser(composerSchema, tokenizer, PARSE_TOKENS);

const ATOM_PLACEHOLDER = '\uFFFC';

function atomText(node: ProseMirrorNode): string {
  if (node.type === composerSchema.nodes.emoticon) return `:${node.attrs.shortcode as string}:`;
  return node.attrs.name as string;
}

/** The literal characters the user typed, with the atoms spelled back out. */
function plainTextOf(doc: ProseMirrorNode): string {
  const { hard_break: hardBreak } = composerSchema.nodes;

  return doc.textBetween(0, doc.content.size, '\n\n', (node) =>
    node.type === hardBreak ? '\n' : atomText(node)
  );
}

function markdownSourceOf(doc: ProseMirrorNode): { source: string; atoms: ProseMirrorNode[] } {
  const { mention, emoticon, hard_break: hardBreak } = composerSchema.nodes;
  const atoms: ProseMirrorNode[] = [];

  const source = doc.textBetween(0, doc.content.size, '\n\n', (node) => {
    if (node.type === hardBreak) return '\n';
    if (node.type !== mention && node.type !== emoticon) return '';
    atoms.push(node);
    return ATOM_PLACEHOLDER;
  });

  return { source, atoms };
}

function spliceAtoms(node: ProseMirrorNode, atoms: ProseMirrorNode[]): ProseMirrorNode {
  if (node.isLeaf) return node;

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    if (!child.isText) {
      children.push(spliceAtoms(child, atoms));
      return;
    }

    for (const [index, part] of (child.text ?? '').split(ATOM_PLACEHOLDER).entries()) {
      if (index > 0) {
        const atom = atoms.shift();
        if (atom) children.push(node.type.spec.code ? composerSchema.text(atomText(atom)) : atom);
      }
      if (part !== '') children.push(composerSchema.text(part, child.marks));
    }
  });

  return node.copy(Fragment.fromArray(children));
}

/** Plain-text mode: what was typed is the body, parsed as markdown for the HTML. */
export function serializePlain(doc: ProseMirrorNode): ComposerMessage {
  const body = plainTextOf(doc).trim();
  const mentions = mentionsOf(doc);
  if (body === '') return { body, formatted: null, mentions };

  const { source, atoms } = markdownSourceOf(doc);
  const parsed = spliceAtoms(markdownParser.parse(source.trim()), atoms);
  return { body, formatted: isPlain(parsed) ? null : html(parsed), mentions };
}
