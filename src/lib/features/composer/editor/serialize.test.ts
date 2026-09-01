// @vitest-environment happy-dom

import { Fragment, Slice, type Node as ProseMirrorNode } from 'prosemirror-model';
import { describe, expect, test } from 'vitest';

import { composerSchema, parseMatrixHtml } from './schema';
import { markdownFromSlice, serializeComposer, serializePlain } from './serialize';

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

  test('inline and fenced code produce Matrix HTML', () => {
    const inline = serializePlain(docOf(para(composerSchema.text('`const x = 1`'))));
    const block = serializePlain(docOf(para(composerSchema.text('```\nconst x = 1;\n```'))));

    expect(inline.formatted).toBe('<code>const x = 1</code>');
    expect(block.formatted).toBe('<pre><code>const x = 1;</code></pre>');
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

describe('markup the renderer accepts survives an edit', () => {
  function roundTrip(html: string): string | null {
    return serializeComposer(parseMatrixHtml(html)).formatted;
  }

  test('a code block keeps its language', () => {
    const message = serializeComposer(
      parseMatrixHtml('<pre><code class="language-rust">fn main() {}</code></pre>')
    );

    expect(message.formatted).toBe('<pre><code class="language-rust">fn main() {}</code></pre>');
    expect(message.body).toBe('```rust\nfn main() {}\n```');
  });

  test('a spoiler keeps its reason', () => {
    expect(roundTrip('<span data-mx-spoiler="ending">it was a dream</span>')).toBe(
      '<span data-mx-spoiler="ending">it was a dream</span>'
    );
  });

  test('a table is not flattened away', () => {
    const html = '<table><tbody><tr><th>a</th></tr><tr><td>b</td></tr></tbody></table>';

    expect(roundTrip(html)).toBe(html);
  });

  test('a collapsible section keeps both halves', () => {
    expect(roundTrip('<details><summary>more</summary><p>hidden</p></details>')).toBe(
      '<details><summary>more</summary><p>hidden</p></details>'
    );
  });

  test('colours, scripts and rules are kept', () => {
    expect(roundTrip('<p><span data-mx-color="#ff0000">red</span></p>')).toBe(
      '<span data-mx-color="#ff0000">red</span>'
    );
    expect(roundTrip('<p>H<sub>2</sub>O and x<sup>2</sup></p>')).toBe(
      'H<sub>2</sub>O and x<sup>2</sup>'
    );
    expect(roundTrip('<p>a</p><hr><p>b</p>')).toBe('<p>a</p><hr><p>b</p>');
  });

  test('a code block inside a list item stays inside it', () => {
    expect(roundTrip('<ul><li><pre><code>x</code></pre></li></ul>')).toBe(
      '<ul><li><pre><code>x</code></pre></li></ul>'
    );
  });

  test('a table inside a quote and a list inside a section survive', () => {
    expect(
      roundTrip('<blockquote><table><tbody><tr><td>a</td></tr></tbody></table></blockquote>')
    ).toBe('<blockquote><table><tbody><tr><td>a</td></tr></tbody></table></blockquote>');
    expect(roundTrip('<details><summary>s</summary><ul><li><p>a</p></li></ul></details>')).toBe(
      '<details><summary>s</summary><ul><li><p>a</p></li></ul></details>'
    );
  });

  test('an empty table cell is kept rather than collapsed', () => {
    expect(roundTrip('<table><tbody><tr><td>a</td><td></td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td>a</td><td></td></tr></tbody></table>'
    );
  });

  test('a caption is dropped rather than breaking the table', () => {
    expect(
      roundTrip('<table><caption>cap</caption><tbody><tr><td>a</td></tr></tbody></table>')
    ).toBe('<table><tbody><tr><td>a</td></tr></tbody></table>');
  });

  test('a background colour round trips and a named one is refused', () => {
    expect(roundTrip('<p><span data-mx-bg-color="#00ff00">g</span></p>')).toBe(
      '<span data-mx-bg-color="#00ff00">g</span>'
    );
    expect(roundTrip('<p><span data-mx-bg-color="rebeccapurple">g</span></p>')).toBe(null);
  });

  test('block maths keeps its latex and fences the body', () => {
    const message = serializeComposer(
      parseMatrixHtml('<div data-mx-maths="x^2"><code>x^2</code></div>')
    );

    expect(message.formatted).toBe('<div data-mx-maths="x^2"><code>x^2</code></div>');
    expect(message.body).toBe('$$\nx^2\n$$');
  });

  test('an image keeps whole dimensions and refuses the rest', () => {
    expect(roundTrip('<p><img src="mxc://e/1" alt="a" width="30" height="20"></p>')).toBe(
      '<img src="mxc://e/1" alt="a" width="30" height="20">'
    );
    expect(roundTrip('<p><img src="mxc://e/1" alt="a" height="abc"></p>')).toBe(
      '<img src="mxc://e/1" alt="a">'
    );
  });

  test('a custom emote is not read back as a plain image', () => {
    const parsed = parseMatrixHtml('<p><img data-mx-emoticon src="mxc://e/w" alt=":wave:"></p>');

    expect(parsed.firstChild?.firstChild?.type.name).toBe('emoticon');
  });

  test('the editor trailing paragraph is not sent', () => {
    const message = serializeComposer(
      docOf(
        composerSchema.nodes.code_block.create(null, composerSchema.text('a')),
        paragraph.create()
      )
    );

    expect(message.formatted).toBe('<pre><code>a</code></pre>');
    expect(message.body).toBe('```\na\n```');
  });

  test('only a trailing empty paragraph is dropped, not one between blocks', () => {
    expect(roundTrip('<h2>a</h2><p></p><h2>b</h2>')).toBe('<h2>a</h2><p></p><h2>b</h2>');
  });

  test('a heading below the toolbar keeps its level', () => {
    expect(roundTrip('<h5>deep</h5>')).toBe('<h5>deep</h5>');
  });

  test('a colour the sanitizer would refuse is dropped rather than kept', () => {
    expect(roundTrip('<p><span data-mx-color="rebeccapurple">named</span></p>')).toBe(null);
  });

  test('an inline image keeps its address', () => {
    expect(roundTrip('<p><img src="mxc://example.org/one" alt="a cat"></p>')).toBe(
      '<img src="mxc://example.org/one" alt="a cat">'
    );
  });

  test('maths keeps the latex it was written with', () => {
    expect(roundTrip('<p><span data-mx-maths="\\frac12"><code>\\frac12</code></span></p>')).toBe(
      '<span data-mx-maths="\\frac12"><code>\\frac12</code></span>'
    );
  });
});

describe('links', () => {
  test('a link whose text is its address is written bare in the body', () => {
    const address = 'https://example.org/a_b';
    const message = serializeComposer(
      docOf(para(composerSchema.text(address, [link.create({ href: address })])))
    );

    expect(message.body).toBe(address);
    expect(message.formatted).toBe(`<a href="${address}">${address}</a>`);
  });

  test('a link with its own text keeps markdown syntax', () => {
    const message = serializeComposer(
      docOf(para(composerSchema.text('here', [link.create({ href: 'https://example.org' })])))
    );

    expect(message.body).toBe('[here](https://example.org)');
  });
});

describe('the room ping', () => {
  test('is sent as bare text and reported as a room mention', () => {
    const message = serializeComposer(
      docOf(para([composerSchema.nodes.room_ping.create(), composerSchema.text(' look')]))
    );

    expect(message.body).toBe('@room look');
    expect(message.formatted).toBe(null);
    expect(message.mentions.room).toBe(true);
  });
});

test('plain-text mode keeps an image rather than dropping it', () => {
  const picture = composerSchema.nodes.image.create({ src: 'mxc://example.org/one', alt: 'a cat' });
  const message = serializePlain(docOf(para([composerSchema.text('see '), picture])));

  expect(message.body).toBe('see a cat');
  expect(message.formatted).toBe('see <img src="mxc://example.org/one" alt="a cat">');
});

test('plain-text mode keeps block maths in the body', () => {
  const maths = composerSchema.nodes.math_block.create({ latex: 'x^2' });
  const message = serializePlain(docOf(para(composerSchema.text('see')), maths));

  expect(message.body).toBe('see\n\n$$x^2$$');
});

test('copying plain words puts no markdown escapes on the clipboard', () => {
  const slice = new Slice(Fragment.from(composerSchema.text('5 * 3 [x]')), 0, 0);

  expect(markdownFromSlice(slice)).toBe('5 * 3 [x]');
});

test('copying a selection out of the composer yields markdown', () => {
  const slice = new Slice(
    Fragment.from([composerSchema.text('a '), composerSchema.text('bold', [strong.create()])]),
    0,
    0
  );

  expect(markdownFromSlice(slice)).toBe('a **bold**');
});
