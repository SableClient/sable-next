// @vitest-environment happy-dom

import { DOMParser, DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { expect, onTestFinished, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

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

test('a mention serialises to a Sable link', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      composerSchema.text('hey '),
      mention.create({ userId: '@one:example.org', name: 'Member One' }),
    ]),
  ]);

  expect(html(doc)).toBe('<p>hey <a href="matrix:u/one:example.org">Member One</a></p>');
});

test('a room mention serialises to a Sable link', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [mention.create({ userId: '#general:example.org', name: '#General' })]),
  ]);

  expect(html(doc)).toBe('<p><a href="matrix:r/general:example.org">#General</a></p>');
});

test.each(['link.sable.moe', 'matrix.to'])(
  'a room %s anchor becomes a mention when pasted',
  (host) => {
    const doc = parse(`<p><a href="https://${host}/#/#general:example.org">#General</a></p>`);

    expect(doc.firstChild?.firstChild?.attrs).toEqual({
      userId: '#general:example.org',
      name: '#General',
      via: [],
    });
  }
);

test('an anchor on the custom link host becomes a mention when pasted', () => {
  preferences.matrixLinkSelector = 'custom';
  preferences.matrixLinkCustom = 'links.example.org';
  onTestFinished(() => {
    preferences.matrixLinkSelector = 'sable';
    preferences.matrixLinkCustom = '';
  });

  const doc = parse('<p><a href="https://links.example.org/#/@alice:example.org">Alice</a></p>');

  expect(doc.firstChild?.firstChild?.type).toBe(mention);
  expect(doc.firstChild?.firstChild?.attrs.userId).toBe('@alice:example.org');
});

test.each(['link.sable.moe', 'matrix.to'])(
  'a %s link to one event stays a link when pasted',
  (host) => {
    const href = `https://${host}/#/!room:example.org/$event?via=example.org`;
    const doc = parse(`<p><a href="${href}">see this</a></p>`);

    expect(doc.firstChild?.firstChild?.type.name).toBe('text');
    expect(doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe(href);
  }
);

test('a percent-encoded mention is read like a plain one', () => {
  const doc = parse('<p><a href="https://matrix.to/#/%40one%3Aexample.org">Member One</a></p>');

  expect(doc.firstChild?.firstChild?.attrs).toEqual({
    userId: '@one:example.org',
    name: 'Member One',
    via: [],
  });
});

test('a plain link is not a mention', () => {
  const doc = parse('<p><a href="https://example.org/#/@alice:example.org">Alice</a></p>');

  expect(doc.firstChild?.firstChild?.isText).toBe(true);
  expect(doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(['link']);
});

test('a room permalink with via servers keeps them out of the room id', () => {
  const doc = parse(
    '<p><a href="matrix:roomid/6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe">#Sable</a></p>'
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
    '<p><a href="matrix:roomid/abc:example.org?via=sable.moe&amp;via=a.example">#Sable</a></p>'
  );
});

test('an alias mention takes no via, since it resolves through its own domain', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      mention.create({ userId: '#general:example.org', name: '#General', via: ['example.org'] }),
    ]),
  ]);

  expect(html(doc)).toBe('<p><a href="matrix:r/general:example.org">#General</a></p>');
});

test('an emote serialises to the MSC2545 image the sanitiser allows', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' })]),
  ]);

  expect(html(doc)).toBe(
    '<p><img data-mx-emoticon="" src="mxc://example.org/wave" alt="wave" title="wave" height="32"></p>'
  );
});

test('both atoms survive a clipboard round trip', () => {
  const source =
    '<p>hey <a href="matrix:u/one:example.org">Member One</a> ' +
    '<img data-mx-emoticon src="mxc://example.org/wave" alt="wave"></p>';
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
    body: null,
    sourcePack: null,
  });
});

test('an ordinary link stays text, so only real mentions become atoms', () => {
  const doc = parse('<p>see <a href="https://example.org/docs">the docs</a></p>');

  expect(doc.textContent).toBe('see the docs');
  expect(doc.firstChild?.child(0).type.name).toBe('text');
});

test('underline serialises to <u> and parses back for edit', () => {
  const { underline } = composerSchema.marks;
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, composerSchema.text('under', [underline.create()])),
  ]);

  expect(html(doc)).toBe('<p><u>under</u></p>');
  expect(parse(html(doc)).firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
    'underline',
  ]);
});

test('a spoiler serialises to the data-mx-spoiler span and parses back for edit', () => {
  const { spoiler } = composerSchema.marks;
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, composerSchema.text('shh', [spoiler.create()])),
  ]);

  expect(html(doc)).toBe('<p><span data-mx-spoiler="">shh</span></p>');
  expect(parse(html(doc)).firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
    'spoiler',
  ]);
});

test('a room ping round trips through its own span', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [composerSchema.nodes.room_ping.create(), composerSchema.text(' hi')]),
  ]);
  const markup = html(doc);
  expect(markup).toBe('<p><span data-sable-room-ping="">@room</span> hi</p>');
  expect(parse(markup).firstChild?.firstChild?.type.name).toBe('room_ping');
});

test('a code block reads its language from either the pre or the code class', () => {
  expect(parse('<pre class="language-go"><code>x</code></pre>').firstChild?.attrs.language).toBe(
    'go'
  );
  expect(parse('<pre><code class="language-rs">x</code></pre>').firstChild?.attrs.language).toBe(
    'rs'
  );
  expect(parse('<pre><code>x</code></pre>').firstChild?.attrs.language).toBe('');
});

test('a b that sets its weight back to normal is not bold', () => {
  const doc = parse(
    '<b style="font-weight:normal;" id="docs-internal-guid-x"><span>a</span></b><b>b</b>'
  );

  expect(doc.firstChild?.child(0).marks).toEqual([]);
  expect(doc.firstChild?.child(1).marks.map((mark) => mark.type.name)).toEqual(['strong']);
});

test('a Google Docs paste keeps the bold its spans set by weight', () => {
  const doc = parse(
    '<b style="font-weight:normal;" id="docs-internal-guid-x"><span style="font-weight:700;">bold</span><span style="font-weight:400;"> plain</span></b>'
  );

  expect(doc.firstChild?.child(0).text).toBe('bold');
  expect(doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toEqual(['strong']);
  expect(doc.firstChild?.child(1).marks).toEqual([]);
});

test('an emote description survives HTML and draft round trips', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave', body: 'A cat waving' }),
    ]),
  ]);
  const output = html(doc);
  expect(output).toContain('alt="A cat waving" title="wave"');
  expect(parse(output).firstChild?.firstChild?.attrs).toMatchObject({
    shortcode: 'wave',
    body: 'A cat waving',
  });
  expect(composerSchema.nodeFromJSON(doc.toJSON()).eq(doc)).toBe(true);
});

test('an emote whose description is its own address is sent with its shortcode', () => {
  const doc = composerSchema.node('doc', null, [
    paragraph.create(null, [
      emoticon.create({
        url: 'mxc://example.org/wave',
        shortcode: 'wave',
        body: 'mxc://example.org/wave',
      }),
    ]),
  ]);

  expect(html(doc)).toContain('alt="wave" title="wave"');
});

test('an explicit Sable link keeps its marker on serialise', () => {
  const doc = parse(
    '<a data-org.matrix.msc4550.link href="https://link.sable.moe/#/@alice:example.org">DM me</a>'
  );
  let mentions = 0;
  doc.descendants((node) => {
    if (node.type.name === 'mention') mentions += 1;
  });
  expect(mentions).toBe(0);
  expect(html(doc)).toContain('data-org.matrix.msc4550.link');
});
