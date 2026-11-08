import { describe, expect, it } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

import PostLinkPreview from './PostLinkPreview.svelte';
import YoutubeLinkPreview from './YoutubeLinkPreview.svelte';
import { findLinkPresentation } from './link-presentations';

const preview: UrlPreviewView = {
  url: 'https://example.org/',
  title: 'Example',
  description: null,
  site_name: null,
  image: null,
  image_mime: null,
  image_width: null,
  image_height: null,
  video: null,
  theme_color: null,
  card: null,
  author_name: null,
  post: null,
};

describe('findLinkPresentation', () => {
  it('uses the YouTube card for recognised YouTube URLs', () => {
    expect(findLinkPresentation('https://youtu.be/MTn_bhTVr2U', preview)).toBe(YoutubeLinkPreview);
  });

  it('uses the post card for any preview that carries a post', () => {
    const post = {
      url: null,
      author: { name: null, handle: 'alice.test', avatar: null, url: null },
      text: 'hello',
      created_at: null,
      media: [],
      stats: null,
      sensitivity: null,
      sensitivity_reason: null,
      quote: null,
    };
    expect(findLinkPresentation('https://example.org/', { ...preview, post })).toBe(
      PostLinkPreview
    );
  });

  it('keeps unknown websites on the generic card', () => {
    expect(findLinkPresentation('https://example.org/', preview)).toBeNull();
  });
});
