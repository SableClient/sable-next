import { describe, expect, it } from 'vitest';

import { instagramEmbedUrl, parseInstagramLink } from './instagram';

describe('parseInstagramLink', () => {
  it.each([
    ['https://www.instagram.com/p/CxYz_123-ab/', { code: 'CxYz_123-ab', kind: 'p' }],
    ['https://instagram.com/p/CxYz_123-ab?igsh=abc', { code: 'CxYz_123-ab', kind: 'p' }],
    ['https://www.instagram.com/reel/CxYz_123-ab/', { code: 'CxYz_123-ab', kind: 'reel' }],
    ['https://www.instagram.com/reels/CxYz_123-ab/', { code: 'CxYz_123-ab', kind: 'reel' }],
    ['https://www.instagram.com/tv/CxYz_123-ab/', { code: 'CxYz_123-ab', kind: 'tv' }],
    ['https://www.instagram.com/some.user/p/CxYz_123-ab/', { code: 'CxYz_123-ab', kind: 'p' }],
    [
      'https://www.instagram.com/some.user/reel/CxYz_123-ab/',
      { code: 'CxYz_123-ab', kind: 'reel' },
    ],
  ])('reads %s', (href, post) => {
    expect(parseInstagramLink(href)).toEqual(post);
  });

  it.each([
    'https://www.instagram.com/',
    'https://www.instagram.com/some.user/',
    'https://www.instagram.com/stories/some.user/123456789/',
    'https://www.instagram.com/p/',
    'https://www.instagram.com/p/CxYz_123-ab/extra/more',
    'https://evil.example/p/CxYz_123-ab/',
    'https://notinstagram.com/p/CxYz_123-ab/',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (href) => {
    expect(parseInstagramLink(href)).toBeNull();
  });
});

describe('instagramEmbedUrl', () => {
  it('points at the official embed page', () => {
    expect(instagramEmbedUrl({ code: 'CxYz_123-ab', kind: 'p' })).toBe(
      'https://www.instagram.com/p/CxYz_123-ab/embed/'
    );
    expect(instagramEmbedUrl({ code: 'CxYz_123-ab', kind: 'reel' })).toBe(
      'https://www.instagram.com/reel/CxYz_123-ab/embed/'
    );
    expect(instagramEmbedUrl({ code: 'CxYz_123-ab', kind: 'tv' })).toBe(
      'https://www.instagram.com/p/CxYz_123-ab/embed/'
    );
  });
});
