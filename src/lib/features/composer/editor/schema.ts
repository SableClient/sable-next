import { DOMParser, Schema, type ParseRule } from 'prosemirror-model';

import { splitVia } from '#lib/features/room/join-address.js';

export const matrixTo = 'https://matrix.to/#/';

export const ROOM_PING = '@room';

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

/** A room id is not routable without `via`; an alias resolves on its own. */
export function mentionHref(userId: string, via: readonly string[]): string {
  if (!userId.startsWith('!') || via.length === 0) return `${matrixTo}${userId}`;
  const query = new URLSearchParams(via.map((server) => ['via', server]));
  return `${matrixTo}${userId}?${query.toString()}`;
}

function languageOf(dom: HTMLElement): string {
  const classes = `${dom.className} ${dom.querySelector('code')?.className ?? ''}`;
  return /(?:^|\s)language-([\w-]+)/.exec(classes)?.[1] ?? '';
}

function numberAttr(dom: HTMLElement, name: string): number | null {
  const raw = dom.getAttribute(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: HEADING_LEVELS.map((level) => ({ tag: `h${String(level)}`, attrs: { level } })),
      toDOM: (node) => [`h${String(node.attrs.level as number)}`, 0],
    },
    blockquote: {
      content: 'block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    code_block: {
      attrs: { language: { default: '' } },
      content: 'text*',
      group: 'block',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [
        {
          tag: 'pre',
          preserveWhitespace: 'full',
          getAttrs: (dom) => ({ language: languageOf(dom) }),
        },
      ],
      toDOM: (node) => {
        const language = node.attrs.language as string;
        return ['pre', ['code', language === '' ? {} : { class: `language-${language}` }, 0]];
      },
    },
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: 'list_item+',
      group: 'block',
      parseDOM: [
        {
          tag: 'ol',
          getAttrs: (dom) => ({ order: Number(dom.getAttribute('start') ?? '1') }),
        },
      ],
      toDOM: (node) =>
        node.attrs.order === 1
          ? ['ol', 0]
          : ['ol', { start: String(node.attrs.order as number) }, 0],
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    list_item: {
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
    },
    details: {
      content: 'summary block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'details' }],
      toDOM: () => ['details', 0],
    },
    summary: {
      content: 'inline*',
      defining: true,
      parseDOM: [{ tag: 'summary' }],
      toDOM: () => ['summary', 0],
    },
    table: {
      content: 'table_row+',
      group: 'block',
      isolating: true,
      parseDOM: [{ tag: 'table' }],
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
      content: '(table_cell | table_header)+',
      parseDOM: [{ tag: 'tr' }],
      toDOM: () => ['tr', 0],
    },
    table_cell: {
      content: 'inline*',
      isolating: true,
      parseDOM: [{ tag: 'td' }],
      toDOM: () => ['td', 0],
    },
    table_header: {
      content: 'inline*',
      isolating: true,
      parseDOM: [{ tag: 'th' }],
      toDOM: () => ['th', 0],
    },
    math_block: {
      attrs: { latex: {} },
      group: 'block',
      atom: true,
      selectable: true,
      parseDOM: [
        {
          tag: 'div[data-mx-maths]',
          getAttrs: (dom) => ({ latex: dom.getAttribute('data-mx-maths') ?? '' }),
        },
      ],
      toDOM: (node) => {
        const latex = node.attrs.latex as string;
        return ['div', { 'data-mx-maths': latex }, ['code', latex]];
      },
    },
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
    mention: {
      inline: true,
      atom: true,
      group: 'inline',
      selectable: true,
      attrs: { userId: {}, name: {}, via: { default: [] as string[] } },
      parseDOM: [
        {
          tag: `a[href^="${matrixTo}@"], a[href^="${matrixTo}#"], a[href^="${matrixTo}!"]`,
          priority: 60,
          getAttrs: (dom) => {
            const { href, via } = splitVia(dom.getAttribute('href') ?? '');
            return {
              userId: decodeURIComponent(href.slice(matrixTo.length)),
              name: dom.textContent,
              via,
            };
          },
        },
      ],
      toDOM: (node) => [
        'a',
        { href: mentionHref(node.attrs.userId as string, node.attrs.via as string[]) },
        node.attrs.name as string,
      ],
    },
    room_ping: {
      inline: true,
      atom: true,
      group: 'inline',
      selectable: true,
      parseDOM: [{ tag: 'span[data-sable-room-ping]' }],
      toDOM: () => ['span', { 'data-sable-room-ping': '' }, ROOM_PING],
    },
    emoticon: {
      inline: true,
      atom: true,
      group: 'inline',
      selectable: true,
      attrs: { url: {}, shortcode: {} },
      parseDOM: [
        {
          tag: 'img[data-mx-emoticon]',
          priority: 60,
          getAttrs: (dom) => ({
            url: dom.getAttribute('src') ?? '',
            shortcode: (dom.getAttribute('alt') ?? '').replace(/^:|:$/g, ''),
          }),
        },
      ],
      toDOM: (node) => {
        const label = `:${node.attrs.shortcode as string}:`;
        return [
          'img',
          {
            'data-mx-emoticon': '',
            src: node.attrs.url as string,
            alt: label,
            title: label,
            height: '32',
          },
        ];
      },
    },
    image: {
      inline: true,
      atom: true,
      group: 'inline',
      selectable: true,
      attrs: {
        src: {},
        alt: { default: '' },
        title: { default: '' },
        width: { default: null },
        height: { default: null },
      },
      parseDOM: [
        {
          tag: 'img[src]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src') ?? '',
            alt: dom.getAttribute('alt') ?? '',
            title: dom.getAttribute('title') ?? '',
            width: numberAttr(dom, 'width'),
            height: numberAttr(dom, 'height'),
          }),
        },
      ],
      toDOM: (node) => {
        const width = node.attrs.width as number | null;
        const height = node.attrs.height as number | null;
        return [
          'img',
          {
            src: node.attrs.src as string,
            alt: node.attrs.alt as string,
            ...(node.attrs.title === '' ? {} : { title: node.attrs.title as string }),
            ...(width === null ? {} : { width: String(width) }),
            ...(height === null ? {} : { height: String(height) }),
          },
        ];
      },
    },
    math_inline: {
      inline: true,
      atom: true,
      group: 'inline',
      selectable: true,
      attrs: { latex: {} },
      parseDOM: [
        {
          tag: 'span[data-mx-maths]',
          priority: 60,
          getAttrs: (dom) => ({ latex: dom.getAttribute('data-mx-maths') ?? '' }),
        },
      ],
      toDOM: (node) => {
        const latex = node.attrs.latex as string;
        return ['span', { 'data-mx-maths': latex }, ['code', latex]];
      },
    },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong', 0],
    },
    em: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em', 0],
    },
    strike: {
      parseDOM: [{ tag: 'del' }, { tag: 's' }],
      toDOM: () => ['del', 0],
    },
    code: {
      code: true,
      excludes: '_',
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
    underline: {
      parseDOM: [{ tag: 'u' }],
      toDOM: () => ['u', 0],
    },
    sub: {
      excludes: 'sub sup',
      parseDOM: [{ tag: 'sub' }],
      toDOM: () => ['sub', 0],
    },
    sup: {
      excludes: 'sub sup',
      parseDOM: [{ tag: 'sup' }],
      toDOM: () => ['sup', 0],
    },
    color: {
      attrs: { value: {} },
      parseDOM: [
        {
          tag: 'span[data-mx-color]',
          priority: 60,
          getAttrs: (dom) => {
            const value = dom.getAttribute('data-mx-color') ?? '';
            return isMatrixColor(value) ? { value } : false;
          },
        },
      ],
      toDOM: (mark) => ['span', { 'data-mx-color': mark.attrs.value as string }, 0],
    },
    bg_color: {
      attrs: { value: {} },
      parseDOM: [
        {
          tag: 'span[data-mx-bg-color]',
          priority: 60,
          getAttrs: (dom) => {
            const value = dom.getAttribute('data-mx-bg-color') ?? '';
            return isMatrixColor(value) ? { value } : false;
          },
        },
      ],
      toDOM: (mark) => ['span', { 'data-mx-bg-color': mark.attrs.value as string }, 0],
    },
    spoiler: {
      attrs: { reason: { default: '' } },
      parseDOM: [
        {
          tag: 'span[data-mx-spoiler]',
          getAttrs: (dom) => ({ reason: dom.getAttribute('data-mx-spoiler') ?? '' }),
        },
      ],
      toDOM: (mark) => ['span', { 'data-mx-spoiler': mark.attrs.reason as string }, 0],
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href') }) }],
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0],
    },
  },
});

export function isMatrixColor(value: string): boolean {
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
}

const IGNORED_TAGS: readonly ParseRule[] = [{ tag: 'caption', ignore: true }];

export const composerDOMParser = new DOMParser(composerSchema, [
  ...IGNORED_TAGS,
  ...DOMParser.fromSchema(composerSchema).rules,
]);

export function parseMatrixHtml(html: string): ReturnType<typeof composerDOMParser.parse> {
  const parsed = new window.DOMParser().parseFromString(html, 'text/html');
  return composerDOMParser.parse(parsed.body);
}
