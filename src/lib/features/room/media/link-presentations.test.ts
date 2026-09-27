import { describe, expect, it } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

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
};

describe('findLinkPresentation', () => {
  it('uses the YouTube card for recognised YouTube URLs', () => {
    expect(findLinkPresentation('https://youtu.be/MTn_bhTVr2U', preview)).toBe(YoutubeLinkPreview);
  });

  it('keeps unknown websites on the generic card', () => {
    expect(findLinkPresentation('https://example.org/', preview)).toBeNull();
  });
});
