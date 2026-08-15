// @vitest-environment happy-dom

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { expect, test } from 'vitest';

import { composerSchema } from './schema';
import { serializeComposer } from './serialize';

const { doc, paragraph, heading, blockquote, bullet_list, list_item, mention, emoticon } =
  composerSchema.nodes;
const { strong, em, strike, code, link } = composerSchema.marks;

function docOf(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return doc.create(null, blocks);
}

function para(content: ProseMirrorNode | ProseMirrorNode[]): ProseMirrorNode {
  return paragraph.create(null, content);
}

test('plain text sends no formatted body', () => {
  const message = serializeComposer(docOf(para(composerSchema.text('just words'))));

  expect(message).toEqual({ body: 'just words', formatted: null });
});

test('a bold mark serialises to markdown in the body and html in the formatted body', () => {
  const message = serializeComposer(
    docOf(
      para([
        composerSchema.text('a '),
        composerSchema.text('bold', [strong.create()]),
        composerSchema.text(' word'),
      ])
    )
  );

  expect(message.body).toBe('a **bold** word');
  expect(message.formatted).toBe('a <strong>bold</strong> word');
});

test('italic, strike and code each round trip', () => {
  const message = serializeComposer(
    docOf(
      para([
        composerSchema.text('i', [em.create()]),
        composerSchema.text(' '),
        composerSchema.text('s', [strike.create()]),
        composerSchema.text(' '),
        composerSchema.text('c', [code.create()]),
      ])
    )
  );

  expect(message.body).toBe('*i* ~~s~~ `c`');
  expect(message.formatted).toBe('<em>i</em> <del>s</del> <code>c</code>');
});

test('a heading keeps its level', () => {
  const message = serializeComposer(
    docOf(heading.create({ level: 2 }, composerSchema.text('Hello')))
  );

  expect(message.body).toBe('## Hello');
  expect(message.formatted).toBe('<h2>Hello</h2>');
});

test('a bullet list survives both ways', () => {
  const message = serializeComposer(
    docOf(
      bullet_list.create(null, [
        list_item.create(null, para(composerSchema.text('one'))),
        list_item.create(null, para(composerSchema.text('two'))),
      ])
    )
  );

  expect(message.body).toBe('* one\n\n* two');
  expect(message.formatted).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
});

test('a quote survives both ways', () => {
  const message = serializeComposer(
    docOf(blockquote.create(null, para(composerSchema.text('quoted'))))
  );

  expect(message.body).toBe('> quoted');
  expect(message.formatted).toBe('<blockquote><p>quoted</p></blockquote>');
});

test('a link keeps its target', () => {
  const message = serializeComposer(
    docOf(para(composerSchema.text('docs', [link.create({ href: 'https://example.org' })])))
  );

  expect(message.body).toBe('[docs](https://example.org)');
  expect(message.formatted).toBe('<a href="https://example.org">docs</a>');
});

test('a mention keeps its name in the body and links in the formatted body', () => {
  const message = serializeComposer(
    docOf(
      para([
        composerSchema.text('hey '),
        mention.create({ userId: '@one:example.org', name: 'Member One' }),
      ])
    )
  );

  expect(message.body).toBe('hey Member One');
  expect(message.formatted).toBe(
    'hey <a href="https://matrix.to/#/@one:example.org">Member One</a>'
  );
});

test('an emote keeps its shortcode in the body and an image in the formatted body', () => {
  const message = serializeComposer(
    docOf(para(emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' })))
  );

  expect(message.body).toBe(':wave:');
  expect(message.formatted).toBe(
    '<img data-mx-emoticon="" src="mxc://example.org/wave" alt=":wave:" title=":wave:" height="32">'
  );
});

test('several paragraphs stay several paragraphs', () => {
  const message = serializeComposer(
    docOf(para(composerSchema.text('one')), para(composerSchema.text('two')))
  );

  expect(message.body).toBe('one\n\ntwo');
  expect(message.formatted).toBeNull();
});
