// @vitest-environment happy-dom

import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import { expect, test } from 'vitest';

import { composerSchema, parseMatrixHtml } from './schema';
import {
  composerMarkdown,
  plainEditSource,
  richFromPlain,
  serializeComposer,
  serializePlain,
  textDoc,
} from './serialize';

const { strong, em, strike, code, link, spoiler, color, bg_color } = composerSchema.marks;
const normalizeLink = (url: string): string => new MarkdownIt().normalizeLink(url);

const { paragraph, heading, subtext, blockquote, bullet_list, ordered_list, list_item } =
  composerSchema.nodes;
const { code_block, horizontal_rule, table, table_row, table_header, table_cell, hard_break } =
  composerSchema.nodes;

const word = fc.oneof(
  fc.stringMatching(/^[a-z0-9*_`~[\]()\\#>!|:;.=+$&<-]{1,8}$/),
  fc.constantFrom(
    '&amp;',
    '$[fg.color=f00 x]',
    '$[unixtime 0]',
    '<ab:c>',
    '||s||',
    '1.',
    '1)',
    '-#',
    '#',
    '+',
    '===',
    '---',
    '```',
    '~~~'
  )
);
const text = fc.array(word, { minLength: 1, maxLength: 4 }).map((words) => words.join(' '));

const marks = fc
  .record({
    strong: fc.boolean(),
    em: fc.boolean(),
    strike: fc.boolean(),
    spoiler: fc.boolean(),
    code: fc.boolean(),
    color: fc.option(fc.constantFrom('#ff0000', '#00aa11'), { nil: null }),
    background: fc.option(fc.constantFrom('#0000ff', '#123456'), { nil: null }),
    link: fc.option(fc.stringMatching(/^[a-z <>()]{1,5}$/), { nil: null }),
  })
  .map((chosen): Mark[] => {
    if (chosen.code) return [code.create()];
    const set: Mark[] = [];
    if (chosen.strong) set.push(strong.create());
    if (chosen.em) set.push(em.create());
    if (chosen.strike) set.push(strike.create());
    if (chosen.spoiler) set.push(spoiler.create());
    if (chosen.color) set.push(color.create({ value: chosen.color }));
    if (chosen.background) set.push(bg_color.create({ value: chosen.background }));
    if (chosen.link) set.push(link.create({ href: normalizeLink(`https://a.b/${chosen.link}`) }));
    return set;
  });

const autolink = fc
  .stringMatching(/^[a-z0-9/_.&*~-]{1,8}$/)
  .map((path) => normalizeLink(`https://a.b/${path}`))
  .map((href) => composerSchema.text(href, [link.create({ href })]));

const image = fc
  .record({
    path: fc.stringMatching(/^[a-z0-9 ()<>]{1,6}$/),
    alt: fc.oneof(fc.constant(''), text),
    title: fc.oneof(fc.constant(''), text),
  })
  .map(({ path, alt, title }) =>
    composerSchema.nodes.image.create({ src: normalizeLink(`mxc://a.b/${path}`), alt, title })
  );

const run = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ text, marks }).map((part) => composerSchema.text(part.text, part.marks)),
  },
  { weight: 1, arbitrary: autolink },
  { weight: 1, arbitrary: image }
);

const words = fc
  .array(run, { minLength: 1, maxLength: 3 })
  .map((runs) =>
    runs.flatMap((node, index) => [...(index > 0 ? [composerSchema.text(' ')] : []), node])
  );

const codeText = fc
  .array(fc.stringMatching(/^[a-z *_`~#>|-]{0,8}$/), { minLength: 1, maxLength: 3 })
  .map((all) => all.join('\n').replace(/\n+$/, ''))
  .filter((value) => value.trim() !== '');

function documents(padding: fc.Arbitrary<string>): fc.Arbitrary<ProseMirrorNode> {
  const paddedLine = fc
    .tuple(padding, words, padding)
    .map(([before, content, after]) => [
      ...(before ? [composerSchema.text(before)] : []),
      ...content,
      ...(after ? [composerSchema.text(after)] : []),
    ]);

  const lines = fc
    .tuple(paddedLine, fc.array(fc.oneof(paddedLine, fc.constant([])), { maxLength: 3 }))
    .map(([first, rest]) =>
      [first, ...rest].flatMap((content, index) => [
        ...(index > 0 ? [hard_break.create()] : []),
        ...content,
      ])
    )
    .filter((content) => content.at(-1)?.type !== hard_break);

  const leaf = fc.oneof(
    lines.map((content) => paragraph.create(null, content)),
    fc
      .tuple(fc.integer({ min: 1, max: 6 }), words)
      .map(([level, content]) => heading.create({ level }, content)),
    words.map((content) => subtext.create(null, content)),
    fc
      .tuple(fc.stringMatching(/^[a-z]{0,4}$/), codeText)
      .map(([language, value]) => code_block.create({ language }, composerSchema.text(value))),
    fc.constant(horizontal_rule.create()),
    fc
      .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 2, max: 3 }))
      .chain(([columns, rows]) =>
        fc.array(fc.array(words, { minLength: columns, maxLength: columns }), {
          minLength: rows,
          maxLength: rows,
        })
      )
      .map((cells) =>
        table.create(
          null,
          cells.map((row, index) =>
            table_row.create(
              null,
              row.map((content) => (index === 0 ? table_header : table_cell).create(null, content))
            )
          )
        )
      )
  );

  const block: fc.Arbitrary<ProseMirrorNode> = fc.letrec<{ block: ProseMirrorNode }>((tie) => ({
    block: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc
        .array(tie('block'), { minLength: 1, maxLength: 2 })
        .map((content) => blockquote.create(null, content)),
      fc
        .tuple(
          fc.boolean(),
          fc.integer({ min: 1, max: 3 }),
          fc.array(fc.array(tie('block'), { minLength: 1, maxLength: 2 }), {
            minLength: 1,
            maxLength: 3,
          })
        )
        .map(([ordered, order, items]) => {
          const children = items.map((content) => list_item.create(null, content));
          return ordered
            ? ordered_list.create({ order }, children)
            : bullet_list.create(null, children);
        })
    ),
  })).block;

  return fc
    .array(block, { minLength: 1, maxLength: 3 })
    .map((blocks): ProseMirrorNode => composerSchema.nodes.doc.create(null, blocks));
}

const doc = documents(fc.constantFrom('', ' ', '  ', '    '));
const htmlDoc = documents(fc.constant(''));

test('the composer markdown parses back to the document it came from', () => {
  fc.assert(
    fc.property(doc, (source) => {
      const markdown = composerMarkdown(source);
      expect(richFromPlain(textDoc(markdown)).toJSON(), JSON.stringify(markdown)).toEqual(
        source.toJSON()
      );
    }),
    { numRuns: 500 }
  );
});

test('a plain-mode edit of any sent message reproduces its html', () => {
  fc.assert(
    fc.property(htmlDoc, (source) => {
      const message = serializeComposer(source);
      if (message.formatted === null) return;
      const edited = plainEditSource(message.body, message.formatted);
      expect(serializePlain(textDoc(edited)).formatted, JSON.stringify(edited)).toBe(
        message.formatted
      );
    }),
    { numRuns: 500 }
  );
});

test('a rich edit of any sent message reproduces its html', () => {
  fc.assert(
    fc.property(htmlDoc, (source) => {
      const message = serializeComposer(source);
      if (message.formatted === null) return;
      expect(serializeComposer(parseMatrixHtml(message.formatted)).formatted).toBe(
        message.formatted
      );
    }),
    { numRuns: 500 }
  );
});
