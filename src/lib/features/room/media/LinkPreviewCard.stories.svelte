<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect } from 'storybook/test';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import LinkPreviewCard from './LinkPreviewCard.svelte';

  const bundled: UrlPreviewView = {
    url: 'https://example.org/article',
    title: 'Shipping the search crawl fix',
    description: 'How the indexer keeps results steady while older history is still loading.',
    site_name: 'Example',
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

  const { Story } = defineMeta({
    title: 'Message/Preview/Link preview card',
    component: LinkPreviewCard,
    tags: ['autodocs'],
    args: { url: bundled.url, encrypted: false, bundled },
    beforeEach: () => {
      const previous = preferences.urlPreviews;
      preferences.urlPreviews = true;
      return () => {
        preferences.urlPreviews = previous;
      };
    },
    play: async ({ canvas }) => {
      await expect(canvas.getByText(bundled.title ?? '')).toBeVisible();
    },
  });
</script>

<Story name="Default" />

<Story name="Accented" args={{ bundled: { ...bundled, theme_color: '#7c5cff' } }} />

<Story name="Title only" args={{ bundled: { ...bundled, site_name: null, description: null } }} />

<Story
  name="Horizontal 16:9 Image"
  args={{
    bundled: {
      ...bundled,
      card: 'summary_large_image',
      image: 'hi',
      image_width: 160,
      image_height: 90,
    },
  }}
/>
<Story
  name="Horizontal 32:9 Image"
  args={{
    bundled: {
      ...bundled,
      card: 'summary_large_image',
      image: 'hi',
      image_width: 320,
      image_height: 90,
    },
  }}
/>
<Story
  name="Vertical 9:16 Image"
  args={{
    bundled: {
      ...bundled,
      card: 'summary_large_image',
      image: 'hi',
      image_width: 90,
      image_height: 160,
    },
  }}
/>

<Story
  name="Summary Small Image"
  args={{
    bundled: { ...bundled, card: 'summary', image: 'hi', image_width: 90, image_height: 160 },
  }}
/>
