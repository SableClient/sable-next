import { describe, expect, it } from 'vitest';

import { firstPreviewableLink } from './link-preview';

describe('firstPreviewableLink', () => {
  it('finds the only link', () => {
    expect(
      firstPreviewableLink('<span data-plain-body>see <a href="https://example.org/a">a</a></span>')
    ).toBe('https://example.org/a');
  });

  it('returns the first of several links', () => {
    const html =
      '<a href="https://example.org/first">first</a> and <a href="https://example.org/second">second</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/first');
  });

  it('skips a link inside a fenced code block', () => {
    const html =
      '<pre><code>see <a href="https://example.org/hidden">hidden</a></code></pre> ' +
      '<a href="https://example.org/visible">visible</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/visible');
  });

  it('skips a link inside inline code', () => {
    const html =
      '<code><a href="https://example.org/hidden">hidden</a></code> <a href="https://example.org/visible">visible</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/visible');
  });

  it('skips a matrix.to permalink', () => {
    const html =
      '<a href="https://matrix.to/#/%23room:example.org">room</a> <a href="https://example.org/x">x</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/x');
  });

  it('skips a matrix: uri', () => {
    const html =
      '<a href="matrix:r/room:example.org">room</a> <a href="https://example.org/x">x</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/x');
  });

  it('skips a non-http scheme', () => {
    const html =
      '<a href="mailto:alice@example.org">mail</a> <a href="https://example.org/x">x</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/x');
  });

  it('decodes html entities in the href', () => {
    const html = '<a href="https://example.org/x?a=1&amp;b=2">x</a>';
    expect(firstPreviewableLink(html)).toBe('https://example.org/x?a=1&b=2');
  });

  it('returns null with no links', () => {
    expect(firstPreviewableLink('<span data-plain-body>no links here</span>')).toBeNull();
  });

  it('returns null for a malformed href', () => {
    expect(firstPreviewableLink('<a href="not a url">x</a>')).toBeNull();
  });

  it('does not preview a link inside a spoiler', () => {
    expect(
      firstPreviewableLink('<span data-mx-spoiler=""><a href="https://example.org/a">a</a></span>')
    ).toBeNull();
  });

  it('previews a link after a spoiler that holds a nested span', () => {
    expect(
      firstPreviewableLink(
        '<span data-mx-spoiler=""><span>x</span><a href="https://example.org/a">a</a></span>' +
          '<a href="https://example.org/b">b</a>'
      )
    ).toBe('https://example.org/b');
  });

  it('does not preview a link inside a nested code element', () => {
    expect(
      firstPreviewableLink('<code>x<code><a href="https://example.org/a">a</a></code>y</code>')
    ).toBeNull();
  });
});
