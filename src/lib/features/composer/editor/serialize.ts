import MarkdownIt from 'markdown-it';
import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  type ParseSpec,
} from 'prosemirror-markdown';
import {
  DOMSerializer,
  Fragment,
  Slice,
  type Mark,
  type Node as ProseMirrorNode,
} from 'prosemirror-model';

import type { OutgoingMentions } from '#lib/core/client.svelte.js';

import { composerSchema, ROOM_PING } from './schema';

export interface ComposerMessage {
  body: string;
  formatted: string | null;
  mentions: OutgoingMentions;
}

type AutolinkState = MarkdownSerializerState & { inAutolink?: boolean };

function isBareUrl(mark: Mark, parent: ProseMirrorNode, index: number): boolean {
  const child = parent.child(index);
  if (!child.isText || child.marks.length !== 1) return false;
  if (index + 1 < parent.childCount && mark.isInSet(parent.child(index + 1).marks)) return false;

  const href = mark.attrs.href as string;
  const text = child.text ?? '';
  return text === href || `https://${text}` === href || `mailto:${text}` === href;
}

function cellLine(row: ProseMirrorNode): string {
  const cells: string[] = [];
  row.forEach((cell) => cells.push(cell.textContent.replaceAll('|', '\\|').trim()));
  return `| ${cells.join(' | ')} |`;
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
    code_block: (state, node) => {
      state.write(`\`\`\`${node.attrs.language as string}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write('```');
      state.closeBlock(node);
    },
    horizontal_rule: (state, node) => {
      state.write('---');
      state.closeBlock(node);
    },
    details: (state, node) => {
      state.renderContent(node);
    },
    summary: (state, node) => {
      state.write('**');
      state.renderInline(node);
      state.write('**');
      state.closeBlock(node);
    },
    table: (state, node) => {
      node.forEach((row, _offset, index) => {
        state.write(cellLine(row));
        state.ensureNewLine();
        if (index !== 0) return;
        state.write(`|${' --- |'.repeat(row.childCount)}`);
        state.ensureNewLine();
      });
      state.closeBlock(node);
    },
    table_row: () => undefined,
    table_cell: () => undefined,
    table_header: () => undefined,
    math_block: (state, node) => {
      state.write(`$$\n${node.attrs.latex as string}\n$$`);
      state.closeBlock(node);
    },
    math_inline: (state, node) => {
      state.text(`$${node.attrs.latex as string}$`, false);
    },
    room_ping: (state) => {
      state.text(ROOM_PING, false);
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
    sub: { open: '', close: '', mixable: true },
    sup: { open: '', close: '', mixable: true },
    color: { open: '', close: '', mixable: true },
    bg_color: { open: '', close: '', mixable: true },
    spoiler: { open: '||', close: '||', mixable: true, expelEnclosingWhitespace: true },
    link: {
      open: (state, mark, parent, index) => {
        const bare = isBareUrl(mark, parent, index);
        (state as AutolinkState).inAutolink = bare;
        return bare ? '' : '[';
      },
      close: (state, mark, parent, index) => {
        const bare = (state as AutolinkState).inAutolink ?? isBareUrl(mark, parent, index);
        (state as AutolinkState).inAutolink = undefined;
        return bare ? '' : `](${(mark.attrs.href as string).replaceAll(/[()"]/g, '\\$&')})`;
      },
      mixable: true,
    },
  }
);

function withoutTrailingParagraph(doc: ProseMirrorNode): ProseMirrorNode {
  const last = doc.lastChild;
  if (doc.childCount < 2 || !last) return doc;
  if (last.type !== composerSchema.nodes.paragraph || last.content.size > 0) return doc;

  return doc.copy(doc.content.cut(0, doc.content.size - last.nodeSize));
}

function flattenRoomPings(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isLeaf) return node;

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    children.push(
      child.type === composerSchema.nodes.room_ping
        ? composerSchema.text(ROOM_PING)
        : flattenRoomPings(child)
    );
  });

  return node.copy(Fragment.fromArray(children));
}

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
  const mentions = mentionsOf(doc);
  const flat = withoutTrailingParagraph(flattenRoomPings(doc));
  const body = markdown.serialize(flat).trim();
  if (body === '') return { body, formatted: null, mentions };

  return { body, formatted: isPlain(flat) ? null : html(flat), mentions };
}

function mentionsRoom(doc: ProseMirrorNode): boolean {
  let found = false;

  doc.descendants((node) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    if (node.type === composerSchema.nodes.code_block) return false;

    let text = '';
    node.forEach((child) => {
      if (child.type === composerSchema.nodes.room_ping) {
        text += ROOM_PING;
        return;
      }
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

const tokenizer = MarkdownIt('commonmark', { html: false }).enable(['strikethrough', 'table']);

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
    getAttrs: (token) => ({ level: Math.min(6, Number(token.tag.slice(1))) }),
  },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: {
    block: 'code_block',
    noCloseToken: true,
    getAttrs: (token) => ({ language: token.info.trim().split(/\s+/)[0] ?? '' }),
  },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'hard_break' },
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike' },
  code_inline: { mark: 'code', noCloseToken: true },
  link: { mark: 'link', getAttrs: (token) => ({ href: token.attrGet('href') ?? '' }) },
  hr: { node: 'horizontal_rule' },
  image: {
    node: 'image',
    getAttrs: (token) => ({
      src: token.attrGet('src') ?? '',
      alt: token.children?.map((child) => child.content).join('') ?? '',
      title: token.attrGet('title') ?? '',
    }),
  },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header' },
  td: { block: 'table_cell' },
};

const markdownParser = new MarkdownParser(composerSchema, tokenizer, PARSE_TOKENS);

const ATOM_PLACEHOLDER = '\uFFFC';

function atomText(node: ProseMirrorNode): string {
  const { emoticon, room_ping: roomPing, image, math_inline: math } = composerSchema.nodes;
  if (node.type === emoticon) return `:${node.attrs.shortcode as string}:`;
  if (node.type === roomPing) return ROOM_PING;
  if (node.type === image) return (node.attrs.alt as string) || (node.attrs.src as string);
  if (node.type === math) return `$${node.attrs.latex as string}$`;
  if (node.type === composerSchema.nodes.math_block) return `$$${node.attrs.latex as string}$$`;
  return (node.attrs.name as string | undefined) ?? '';
}

const PLACEHOLDER_ATOMS = new Set([
  composerSchema.nodes.mention,
  composerSchema.nodes.emoticon,
  composerSchema.nodes.room_ping,
  composerSchema.nodes.math_inline,
  composerSchema.nodes.image,
]);

/** The literal characters the user typed, with the atoms spelled back out. */
function plainTextOf(doc: ProseMirrorNode): string {
  const { hard_break: hardBreak } = composerSchema.nodes;

  return doc.textBetween(0, doc.content.size, '\n\n', (node) =>
    node.type === hardBreak ? '\n' : atomText(node)
  );
}

function markdownSourceOf(doc: ProseMirrorNode): { source: string; atoms: ProseMirrorNode[] } {
  const { hard_break: hardBreak } = composerSchema.nodes;
  const atoms: ProseMirrorNode[] = [];

  const source = doc.textBetween(0, doc.content.size, '\n\n', (node) => {
    if (node.type === hardBreak) return '\n';
    if (!PLACEHOLDER_ATOMS.has(node.type)) return '';
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
  const parsed = withoutTrailingParagraph(
    flattenRoomPings(spliceAtoms(markdownParser.parse(source.trim()), atoms))
  );
  return { body, formatted: isPlain(parsed) ? null : html(parsed), mentions };
}

export function richFromPlain(doc: ProseMirrorNode): ProseMirrorNode {
  const { source, atoms } = markdownSourceOf(doc);
  return spliceAtoms(markdownParser.parse(source.trim()), atoms);
}

export function markdownSlice(text: string): Slice {
  const parsed = markdownParser.parse(text);
  const only = parsed.childCount === 1 ? parsed.firstChild : null;
  if (only?.type === composerSchema.nodes.paragraph) return new Slice(only.content, 0, 0);
  return new Slice(parsed.content, 0, 0);
}

export function textSlice(text: string): Slice {
  const blocks = text.split(/(?:\r\n?|\n){2,}/).map((block) => {
    const content: ProseMirrorNode[] = [];
    for (const [index, line] of block.split(/\r\n?|\n/).entries()) {
      if (index > 0) content.push(composerSchema.nodes.hard_break.create());
      if (line !== '') content.push(composerSchema.text(line));
    }
    return composerSchema.nodes.paragraph.create(null, content);
  });

  const only = blocks.length === 1 ? blocks[0] : null;
  if (only) return new Slice(only.content, 0, 0);
  return new Slice(Fragment.fromArray(blocks), 0, 0);
}

export function markdownFromSlice(slice: Slice): string {
  const inline = slice.content.firstChild?.isInline ?? false;
  const content = inline
    ? Fragment.from(composerSchema.nodes.paragraph.create(null, slice.content))
    : slice.content;

  const doc = flattenRoomPings(composerSchema.topNodeType.create(null, content));
  return isPlain(doc) ? plainTextOf(doc) : markdown.serialize(doc);
}
