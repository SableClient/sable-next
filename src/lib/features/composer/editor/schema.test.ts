// @vitest-environment happy-dom

import { DOMParser, DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { expect, test } from 'vitest';

import { composerSchema } from './schema';

function html(doc: ProseMirrorNode): string {
  const fragment = DOMSerializer.fromSchema(composerSchema).serializeFragment(doc.content);
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

function parse(source: string): ProseMirrorNode {
  const holder = document.createElement('div');
  holder.innerHTML = source;
  return DOMParser.fromSchema(composerSchema).parse(holder);
}

const { paragraph, mention, emoticon } = composerSchema.nodes;

test('a mention serialises to the matrix.to anchor the timeline already parses', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      composerSchema.text('hey '),
      mention.create({ userId: '@one:example.org', name: 'Member One' }),
    ]),
  ]);

  expect(html(doc)).toBe(
    '<p>hey <a href="https://matrix.to/#/@one:example.org">Member One</a></p>'
  );
});

test('a room mention serialises to a room matrix.to anchor', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [mention.create({ userId: '#general:example.org', name: '#General' })]),
  ]);

  expect(html(doc)).toBe('<p><a href="https://matrix.to/#/#general:example.org">#General</a></p>');
});

test('a room matrix.to anchor becomes a mention when pasted', () => {
  const doc = parse('<p><a href="https://matrix.to/#/#general:example.org">#General</a></p>');

  expect(doc.firstChild?.firstChild?.attrs).toEqual({
    userId: '#general:example.org',
    name: '#General',
    via: [],
  });
});

test('a room permalink with via servers keeps them out of the room id', () => {
  const doc = parse(
    '<p><a href="https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe">#Sable</a></p>'
  );

  expect(doc.firstChild?.firstChild?.attrs).toEqual({
    userId: '!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI',
    name: '#Sable',
    via: ['sable.moe'],
  });
});

test('a room id mention serialises with the via servers that make it routable', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      mention.create({
        userId: '!abc:example.org',
        name: '#Sable',
        via: ['sable.moe', 'a.example'],
      }),
    ]),
  ]);

  expect(html(doc)).toBe(
    '<p><a href="https://matrix.to/#/!abc:example.org?via=sable.moe&amp;via=a.example">#Sable</a></p>'
  );
});

test('an alias mention takes no via, since it resolves through its own domain', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      mention.create({ userId: '#general:example.org', name: '#General', via: ['example.org'] }),
    ]),
  ]);

  expect(html(doc)).toBe('<p><a href="https://matrix.to/#/#general:example.org">#General</a></p>');
});

test('an emote serialises to the MSC2545 image the sanitiser allows', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' })]),
  ]);

  expect(html(doc)).toBe(
    '<p><img data-mx-emoticon="" src="mxc://example.org/wave" alt=":wave:" title=":wave:" height="32"></p>'
  );
});

test('both atoms survive a clipboard round trip', () => {
  const source =
    '<p>hey <a href="https://matrix.to/#/@one:example.org">Member One</a> ' +
    '<img data-mx-emoticon src="mxc://example.org/wave" alt=":wave:"></p>';
  const doc = parse(source);
  const kinds = [...Array(doc.firstChild?.childCount ?? 0).keys()].map(
    (index) => doc.firstChild?.child(index).type.name
  );

  expect(kinds).toEqual(['text', 'mention', 'text', 'emoticon']);
  expect(doc.firstChild?.child(1).attrs).toEqual({
    userId: '@one:example.org',
    name: 'Member One',
    via: [],
  });
  expect(doc.firstChild?.child(3).attrs).toEqual({
    url: 'mxc://example.org/wave',
    shortcode: 'wave',
  });
});

test('an ordinary link stays text, so only real mentions become atoms', () => {
  const doc = parse('<p>see <a href="https://example.org/docs">the docs</a></p>');

  expect(doc.textContent).toBe('see the docs');
  expect(doc.firstChild?.child(0).type.name).toBe('text');
});
