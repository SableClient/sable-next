import type {
  BlockContent,
  Break,
  Heading,
  Image,
  ListItem,
  MfmColor,
  PhrasingContent,
  Spoiler,
  Subtext,
  TableRow,
  Text,
  Verbatim,
} from 'mdast';
import { gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import {
  defaultHandlers,
  toMarkdown,
  type Handle,
  type Info,
  type Options,
  type State,
} from 'mdast-util-to-markdown';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';

import { mfmUnixtime } from '../time-markup';
import { composerSchema, ROOM_PING } from './schema';

declare module 'mdast' {
  interface Spoiler extends Parent {
    type: 'spoiler';
    children: PhrasingContent[];
  }
  interface MfmColor extends Parent {
    type: 'mfmColor';
    name: 'fg' | 'bg';
    value: string;
    children: PhrasingContent[];
  }
  interface Verbatim extends Literal {
    type: 'verbatim';
  }
  interface Subtext extends Parent {
    type: 'subtext';
    children: PhrasingContent[];
  }
  interface PhrasingContentMap {
    spoiler: Spoiler;
    mfmColor: MfmColor;
    verbatim: Verbatim;
  }
  interface BlockContentMap {
    subtext: Subtext;
    verbatim: Verbatim;
  }
  interface RootContentMap {
    spoiler: Spoiler;
    mfmColor: MfmColor;
    subtext: Subtext;
    verbatim: Verbatim;
  }
}

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap {
    spoiler: 'spoiler';
    mfmColor: 'mfmColor';
  }
}

const { nodes, marks } = composerSchema;
const UNWRAPPED_MARKS = new Set([marks.underline, marks.sub, marks.sup, marks.code]);

function wrap(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case marks.strong:
      return { type: 'strong', children };
    case marks.em:
      return { type: 'emphasis', children };
    case marks.strike:
      return { type: 'delete', children };
    case marks.link:
      return { type: 'link', url: mark.attrs.href as string, children };
    case marks.spoiler:
      return { type: 'spoiler', children };
    case marks.color:
    case marks.bg_color:
      return {
        type: 'mfmColor',
        name: mark.type === marks.color ? 'fg' : 'bg',
        value: (mark.attrs.value as string).slice(1),
        children,
      };
    default:
      throw new Error(`Mark type \`${mark.type.name}\` not supported by Markdown renderer`);
  }
}

function leaf(node: ProseMirrorNode): PhrasingContent {
  switch (node.type) {
    case nodes.text:
      return marks.code.isInSet(node.marks)
        ? { type: 'inlineCode', value: node.text ?? '' }
        : { type: 'text', value: node.text ?? '' };
    case nodes.hard_break:
      return { type: 'break' };
    case nodes.image:
      return {
        type: 'image',
        url: node.attrs.src as string,
        alt: (node.attrs.alt as string) || null,
        title: (node.attrs.title as string) || null,
      };
    case nodes.mention:
      return { type: 'text', value: node.attrs.name as string };
    case nodes.emoticon:
      return { type: 'text', value: `:${node.attrs.shortcode as string}:` };
    case nodes.room_ping:
      return { type: 'text', value: ROOM_PING };
    case nodes.mfm_time:
      return { type: 'verbatim', value: mfmUnixtime(node.attrs.datetime as string) };
    case nodes.math_inline:
      return { type: 'verbatim', value: `$${node.attrs.latex as string}$` };
    default:
      return { type: 'text', value: node.textContent };
  }
}

function inline(parent: ProseMirrorNode): PhrasingContent[] {
  const root: PhrasingContent[] = [];
  const open: { mark: Mark; children: PhrasingContent[] }[] = [];

  for (const node of parent.children) {
    const wanted = node.marks.filter((mark) => !UNWRAPPED_MARKS.has(mark.type));
    let keep = 0;
    while (keep < open.length && keep < wanted.length && open[keep]?.mark.eq(wanted[keep])) {
      keep += 1;
    }
    open.length = keep;
    for (const mark of wanted.slice(keep)) {
      const children: PhrasingContent[] = [];
      (open.at(-1)?.children ?? root).push(wrap(mark, children));
      open.push({ mark, children });
    }
    (open.at(-1)?.children ?? root).push(leaf(node));
  }

  return root;
}

function blocks(parent: ProseMirrorNode): BlockContent[] {
  return parent.children.flatMap(block);
}

function listItem(node: ProseMirrorNode): ListItem {
  return { type: 'listItem', spread: node.childCount > 1, children: blocks(node) };
}

function tableRow(node: ProseMirrorNode): TableRow {
  return {
    type: 'tableRow',
    children: node.children.map((cell) => ({ type: 'tableCell', children: inline(cell) })),
  };
}

function block(node: ProseMirrorNode): BlockContent[] {
  switch (node.type) {
    case nodes.heading:
      return [
        { type: 'heading', depth: node.attrs.level as Heading['depth'], children: inline(node) },
      ];
    case nodes.subtext:
      return [{ type: 'subtext', children: inline(node) }];
    case nodes.blockquote:
      return [{ type: 'blockquote', children: blocks(node) }];
    case nodes.bullet_list:
      return [
        { type: 'list', ordered: false, spread: false, children: node.children.map(listItem) },
      ];
    case nodes.ordered_list:
      return [
        {
          type: 'list',
          ordered: true,
          start: node.attrs.order as number,
          spread: false,
          children: node.children.map(listItem),
        },
      ];
    case nodes.code_block:
      return [
        { type: 'code', lang: (node.attrs.language as string) || null, value: node.textContent },
      ];
    case nodes.horizontal_rule:
      return [{ type: 'thematicBreak' }];
    case nodes.table:
      return [{ type: 'table', children: node.children.map(tableRow) }];
    case nodes.details:
      return blocks(node);
    case nodes.summary:
      return [{ type: 'paragraph', children: [{ type: 'strong', children: inline(node) }] }];
    case nodes.math_block:
      return [{ type: 'verbatim', value: `$$\n${node.attrs.latex as string}\n$$` }];
    default:
      return node.isTextblock ? [{ type: 'paragraph', children: inline(node) }] : blocks(node);
  }
}

function characterReference(character: string): string {
  return `&#x${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()};`;
}

function wrapPhrasing(
  node: Spoiler | MfmColor,
  state: State,
  info: Info,
  open: string,
  close: string
): string {
  const tracker = state.createTracker(info);
  const inCell = state.stack.includes('tableCell');
  const exit = state.enter(node.type);
  let value = tracker.move(inCell ? open.replaceAll('|', '\\|') : open);
  value += state
    .containerPhrasing(node, { ...tracker.current(), before: value, after: close.charAt(0) })
    .replace(/^\s/, characterReference)
    .replace(
      /(\\*)(\s)$/,
      (_match, slashes: string, space: string) =>
        `${slashes}${slashes.length % 2 === 1 ? '\\' : ''}${characterReference(space)}`
    );
  value += tracker.move(inCell ? close.replaceAll('|', '\\|') : close);
  exit();
  return value;
}

const spoiler: Handle = Object.assign(
  (node: Spoiler, _parent: unknown, state: State, info: Info) =>
    wrapPhrasing(node, state, info, '||', '||'),
  { peek: () => '|' }
);

const mfmColor: Handle = Object.assign(
  (node: MfmColor, _parent: unknown, state: State, info: Info) =>
    wrapPhrasing(node, state, info, `$[${node.name}.color=${node.value} `, ']'),
  { peek: () => '$' }
);

const hardBreak: Handle = (node: Break, parent, state, info) => {
  const value = defaultHandlers.break(node, parent, state, info);
  const siblings = parent?.children ?? [];
  const index = siblings.indexOf(node);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  return value === '\\\n' && previous && previous.type !== 'break' ? '\n' : value;
};

const text: Handle = (node: Text, _parent, state, info) =>
  state.safe(node.value, state.stack.includes('tableCell') ? { ...info, encode: ['|'] } : info);

const image: Handle = (node: Image, parent, state, info) => {
  const value = defaultHandlers.image(node, parent, state, info);
  if (!state.stack.includes('tableCell')) return value;
  return value.replaceAll(/(?<!\\)((?:\\\\)*)\\\|/g, '$1&#x7C;');
};

const verbatim: Handle = (node: Verbatim) => node.value;

const subtext: Handle = (node: Subtext, _parent, state, info) => {
  const tracker = state.createTracker(info);
  const exit = state.enter('phrasing');
  let value = tracker.move('-# ');
  value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: '\n' });
  exit();
  return value;
};

const options: Options = {
  bullet: '*',
  bulletOther: '+',
  emphasis: '*',
  rule: '-',
  fences: true,
  listItemIndent: 'one',
  extensions: [gfmStrikethroughToMarkdown(), gfmTableToMarkdown({ tablePipeAlign: false })],
  handlers: {
    break: hardBreak,
    image,
    text,
    spoiler,
    mfmColor,
    subtext,
    verbatim,
  },
  unsafe: [
    { character: '|', inConstruct: 'phrasing', after: '\\|' },
    { character: '|', inConstruct: 'spoiler' },
    { character: ']', inConstruct: 'mfmColor' },
    { character: '-', atBreak: true, after: '#' },
  ],
};

export function docToMarkdown(doc: ProseMirrorNode): string {
  return toMarkdown({ type: 'root', children: blocks(doc) }, options).trim();
}
