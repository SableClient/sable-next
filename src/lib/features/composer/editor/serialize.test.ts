// @vitest-environment happy-dom

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { describe, expect, test } from 'vitest';

import { composerSchema } from './schema';
import { serializeComposer, serializePlain } from './serialize';

const { doc, paragraph, heading, blockquote, bullet_list, list_item, mention, emoticon } =
  composerSchema.nodes;
const { strong, em, strike, code, link, underline, spoiler } = composerSchema.marks;

function docOf(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return doc.create(null, blocks);
}

function para(content: ProseMirrorNode | ProseMirrorNode[]): ProseMirrorNode {
  return paragraph.create(null, content);
}

test('plain text sends no formatted body', () => {
  const message = serializeComposer(docOf(para(composerSchema.text('just words'))));

  expect(message).toEqual({
    body: 'just words',
    formatted: null,
    mentions: { userIds: [], room: false },
  });
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

test('underline and spoiler each serialise to their Matrix HTML', () => {
  const message = serializeComposer(
    docOf(
      para([
        composerSchema.text('u', [underline.create()]),
        composerSchema.text(' '),
        composerSchema.text('secret', [spoiler.create()]),
      ])
    )
  );

  expect(message.body).toBe('u ||secret||');
  expect(message.formatted).toBe('<u>u</u> <span data-mx-spoiler="">secret</span>');
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

test('a room mention keeps its # name in the body and links in the formatted body', () => {
  const message = serializeComposer(
    docOf(para(mention.create({ userId: '#general:example.org', name: '#General' })))
  );

  expect(message).toEqual({
    body: '#General',
    formatted: '<a href="https://matrix.to/#/#general:example.org">#General</a>',
    mentions: { userIds: [], room: false },
  });
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

test('a user pill becomes an m.mentions entry, once', () => {
  const message = serializeComposer(
    docOf(
      para([
        composerSchema.nodes.mention.create({ userId: '@one:example.org', name: 'One' }),
        composerSchema.text(' and '),
        composerSchema.nodes.mention.create({ userId: '@one:example.org', name: 'One' }),
      ])
    )
  );

  expect(message.mentions).toEqual({ userIds: ['@one:example.org'], room: false });
});

test('@room in the body asks for a room mention', () => {
  const message = serializeComposer(docOf(para(composerSchema.text('@room heads up'))));

  expect(message.mentions).toEqual({ userIds: [], room: true });
});

test('a word ending in @room is not a room mention', () => {
  const message = serializeComposer(docOf(para(composerSchema.text('mail me at me@room'))));

  expect(message.mentions.room).toBe(false);
});

test('a soft break keeps its formatting and leaves no escape in the body', () => {
  const { hard_break: hb } = composerSchema.nodes;
  const message = serializeComposer(
    docOf(
      para([composerSchema.text('one', [strong.create()]), hb.create(), composerSchema.text('two')])
    )
  );

  expect(message.body).toBe('**one**\ntwo');
  expect(message.formatted).toBe('<strong>one</strong><br>two');
});

describe('plain text mode', () => {
  test('the body is what was typed and the html is parsed from it', () => {
    const message = serializePlain(docOf(para(composerSchema.text('say **hi** now'))));

    expect(message.body).toBe('say **hi** now');
    expect(message.formatted).toBe('say <strong>hi</strong> now');
  });

  test('markdown characters are not escaped back into the body', () => {
    const message = serializePlain(docOf(para(composerSchema.text('a *b* c'))));
    expect(message.body).toBe('a *b* c');
  });

  test('plain prose sends without a formatted body', () => {
    const message = serializePlain(docOf(para(composerSchema.text('just words'))));

    expect(message.body).toBe('just words');
    expect(message.formatted).toBeNull();
  });

  test('strikethrough parses even though commonmark leaves it off', () => {
    const message = serializePlain(docOf(para(composerSchema.text('a ~~b~~ c'))));
    expect(message.formatted).toBe('a <del>b</del> c');
  });

  test('a mention keeps its user id and renders as a matrix.to link', () => {
    const who = mention.create({ userId: '@amp:example.org', name: 'amp' });
    const message = serializePlain(docOf(para([who, composerSchema.text(' hi')])));

    expect(message.mentions.userIds).toEqual(['@amp:example.org']);
    expect(message.formatted).toContain('https://matrix.to/#/@amp:example.org');
  });

  test('the body names the mention rather than spelling out its link', () => {
    const who = mention.create({ userId: '@amp:example.org', name: 'amp' });
    const message = serializePlain(docOf(para([who, composerSchema.text(' hi')])));

    expect(message.body).toBe('amp hi');
  });

  test('a custom emote survives as an image, not as its shortcode', () => {
    const wave = emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' });
    const message = serializePlain(docOf(para([composerSchema.text('hey '), wave])));

    expect(message.body).toBe('hey :wave:');
    expect(message.formatted).toBe(
      'hey <img data-mx-emoticon="" src="mxc://example.org/wave" alt=":wave:" title=":wave:" height="32">'
    );
  });

  test('markdown around an emote still parses', () => {
    const wave = emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' });
    const message = serializePlain(docOf(para([composerSchema.text('**hey** '), wave])));

    expect(message.formatted).toContain('<strong>hey</strong>');
    expect(message.formatted).toContain('data-mx-emoticon');
  });
});

describe('@room', () => {
  test('is picked up from ordinary prose', () => {
    const message = serializeComposer(docOf(para(composerSchema.text('@room stand up'))));

    expect(message.mentions.room).toBe(true);
  });

  test('notifies nobody from inside a code span', () => {
    const message = serializeComposer(docOf(para(composerSchema.text('@room', [code.create()]))));

    expect(message.mentions.room).toBe(false);
  });

  test('notifies nobody from inside a code block', () => {
    const message = serializeComposer(
      docOf(composerSchema.nodes.code_block.create(null, composerSchema.text('@room')))
    );

    expect(message.mentions.room).toBe(false);
  });
});
