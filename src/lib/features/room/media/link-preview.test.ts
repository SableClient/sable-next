// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import {
  previewableLinks,
  imageMimeFromUrl,
  outgoingPreviewableLinks,
  previewGif,
  previewWhitelistEntry,
} from './link-preview';

describe('previewableLinks', () => {
  it('skips a link wrapped in angle brackets, as Discord does', () => {
    const html =
      '<span data-plain-body>&lt;<a href="https://example.org/quiet">https://example.org/quiet</a>&gt; and <a href="https://example.org/loud">https://example.org/loud</a></span>';

    expect(previewableLinks(html)).toEqual(['https://example.org/loud']);
  });

  it('skips a link the body wraps in angle brackets, which markdown consumes', () => {
    const html =
      '<a href="https://example.org/quiet">https://example.org/quiet</a> <a href="https://example.org/loud">loud</a>';
    const body = '<https://example.org/quiet> [loud](https://example.org/loud)';

    expect(previewableLinks(html, body)).toEqual(['https://example.org/loud']);
  });

  it('skips a markdown link whose destination is bracketed', () => {
    const html = '<a href="https://example.org/quiet">https://example.org/quiet</a>';

    expect(
      previewableLinks(html, '[https://example.org/quiet](<https://example.org/quiet>)')
    ).toEqual([]);
  });

  it('finds the only link', () => {
    expect(
      previewableLinks('<span data-plain-body>see <a href="https://example.org/a">a</a></span>')
    ).toEqual(['https://example.org/a']);
  });

  it('returns every link in order', () => {
    const html =
      '<a href="https://example.org/first">first</a> and <a href="https://example.org/second">second</a>';
    expect(previewableLinks(html)).toEqual([
      'https://example.org/first',
      'https://example.org/second',
    ]);
  });

  it('returns a repeated link once', () => {
    const html =
      '<a href="https://example.org/a">a</a> <a href="https://example.org/b">b</a> <a href="https://example.org/a">again</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/a', 'https://example.org/b']);
  });

  it('skips a link inside a fenced code block', () => {
    const html =
      '<pre><code>see <a href="https://example.org/hidden">hidden</a></code></pre> ' +
      '<a href="https://example.org/visible">visible</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/visible']);
  });

  it('skips a link inside inline code', () => {
    const html =
      '<code><a href="https://example.org/hidden">hidden</a></code> <a href="https://example.org/visible">visible</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/visible']);
  });

  it.each(['link.sable.moe', 'matrix.to'])('skips a %s permalink', (host) => {
    const html = `<a href="https://${host}/#/%23room:example.org">room</a> <a href="https://example.org/x">x</a>`;
    expect(previewableLinks(html)).toEqual(['https://example.org/x']);
  });

  it('skips a settings link', () => {
    const html =
      '<a href="https://next.sable.moe/settings/media?focus=url-previews&amp;moe.sable.client.action=settings">s</a> ' +
      `<a href="${location.origin}/settings/appearance">s</a> <a href="https://example.org/x">x</a>`;
    expect(previewableLinks(html)).toEqual(['https://example.org/x']);
  });

  it('skips a matrix: uri', () => {
    const html =
      '<a href="matrix:r/room:example.org">room</a> <a href="https://example.org/x">x</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/x']);
  });

  it('skips a non-http scheme', () => {
    const html =
      '<a href="mailto:alice@example.org">mail</a> <a href="https://example.org/x">x</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/x']);
  });

  it('decodes html entities in the href', () => {
    const html = '<a href="https://example.org/x?a=1&amp;b=2">x</a>';
    expect(previewableLinks(html)).toEqual(['https://example.org/x?a=1&b=2']);
  });

  it('returns nothing with no links', () => {
    expect(previewableLinks('<span data-plain-body>no links here</span>')).toEqual([]);
  });

  it('returns nothing for a malformed href', () => {
    expect(previewableLinks('<a href="not a url">x</a>')).toEqual([]);
  });

  it('does not preview a link inside a spoiler', () => {
    expect(
      previewableLinks('<span data-mx-spoiler=""><a href="https://example.org/a">a</a></span>')
    ).toEqual([]);
  });

  it('previews a link after a spoiler that holds a nested span', () => {
    expect(
      previewableLinks(
        '<span data-mx-spoiler=""><span>x</span><a href="https://example.org/a">a</a></span>' +
          '<a href="https://example.org/b">b</a>'
      )
    ).toEqual(['https://example.org/b']);
  });

  it('does not preview a link inside a nested code element', () => {
    expect(
      previewableLinks('<code>x<code><a href="https://example.org/a">a</a></code>y</code>')
    ).toEqual([]);
  });
});

describe('outgoingPreviewableLinks', () => {
  it('finds bare and explicit links in order, excluding hidden text and link labels', () => {
    const html =
      '<p><strong>See</strong> https://example.org/a ' +
      '<code>https://example.org/code</code> ' +
      '<span data-mx-spoiler>https://example.org/spoiler</span> ' +
      '<a href="https://example.org/b">https://example.org/label</a> ' +
      '&lt;https://example.org/quiet&gt;</p>';
    expect(outgoingPreviewableLinks(html, '')).toEqual([
      'https://example.org/a',
      'https://example.org/b',
    ]);
  });
});

describe('imageMimeFromUrl', () => {
  it('reads the extension of the path, not of the query', () => {
    expect(imageMimeFromUrl('https://media.example/a/anim.gif?name=x.png')).toBe('image/gif');
  });

  it('ignores an extension it does not know, and a malformed url', () => {
    expect(imageMimeFromUrl('https://example.org/a.png')).toBeNull();
    expect(imageMimeFromUrl('not a url')).toBeNull();
  });
});

describe('previewGif', () => {
  const link = 'https://gif.example.org/tweet_video/clip.gif';

  it('offers an uploaded gif image for download and favourites', () => {
    const gif = previewGif([
      { ...previewWhitelistEntry(link), image: 'mxc://example.org/clip', image_mime: 'image/gif' },
    ]);

    expect(gif?.media).toEqual({
      source: 'mxc://example.org/clip',
      filename: 'clip.gif',
      mime: 'image/gif',
    });
    expect(gif?.favorite?.mediaUrl).toBe('mxc://example.org/clip');
  });

  it('downloads the looping video of a gif preview but cannot favourite it', () => {
    const gif = previewGif([
      {
        ...previewWhitelistEntry(link),
        image: 'mxc://example.org/poster',
        image_mime: 'image/jpeg',
        video: {
          source: 'mxc://example.org/clip-video',
          mime: 'video/mp4',
          width: null,
          height: null,
          gif: true,
        },
      },
    ]);

    expect(gif?.media).toEqual({
      source: 'mxc://example.org/clip-video',
      filename: 'clip.mp4',
      mime: 'video/mp4',
    });
    expect(gif?.favorite).toBeUndefined();
  });

  it('ignores a preview that is not a gif', () => {
    expect(
      previewGif([
        {
          ...previewWhitelistEntry('https://example.org/post'),
          image: 'mxc://example.org/still',
          image_mime: 'image/png',
        },
      ])
    ).toBeNull();
  });
});
