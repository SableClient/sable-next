<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import YoutubeLinkPreview from './YoutubeLinkPreview.svelte';

  const preview: UrlPreviewView = {
    url: 'https://youtu.be/f00b4R-1234',
    title: 'Shipping the search crawl fix',
    description: 'How the indexer keeps results steady while older history is still loading.',
    site_name: 'YouTube',
    image: 'https://youtube.com/example.png',
    image_mime: null,
    image_width: 160,
    image_height: 90,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
  };

  const { Story } = defineMeta({
    title: 'Message/Preview/Youtube link preview card',
    component: YoutubeLinkPreview,
    tags: ['autodocs'],
    args: { url: preview.url, preview, mediaHidden: false },
    beforeEach: () => {
      const previous = preferences.urlPreviews;
      preferences.urlPreviews = true;
      return () => {
        preferences.urlPreviews = previous;
      };
    },
  });
</script>

<Story name="Default" />
