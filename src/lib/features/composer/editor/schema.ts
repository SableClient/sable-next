import { Schema } from 'prosemirror-model';

export const matrixTo = 'https://matrix.to/#/';

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
      parseDOM: [1, 2, 3].map((level) => ({ tag: `h${String(level)}`, attrs: { level } })),
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
      content: 'text*',
      group: 'block',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
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
      content: 'paragraph block*',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
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
      attrs: { userId: {}, name: {} },
      parseDOM: [
        {
          tag: `a[href^="${matrixTo}@"], a[href^="${matrixTo}#"], a[href^="${matrixTo}!"]`,
          priority: 60,
          getAttrs: (dom) => ({
            userId: decodeURIComponent((dom.getAttribute('href') ?? '').slice(matrixTo.length)),
            name: dom.textContent,
          }),
        },
      ],
      toDOM: (node) => [
        'a',
        { href: `${matrixTo}${node.attrs.userId as string}` },
        node.attrs.name as string,
      ],
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
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href') }) }],
      toDOM: (mark) => ['a', { href: mark.attrs.href as string }, 0],
    },
  },
});
