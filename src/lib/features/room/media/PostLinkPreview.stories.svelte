<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import type { UrlPreviewView, PostView, PostMediaView } from '#src/generated/protocol';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import PostLinkPreview from './PostLinkPreview.svelte';

  const url = 'https://social.example/alice/post/f00b4r';

  const post: PostView = {
    url,
    author: {
      name: 'Alice',
      handle: 'alice',
      avatar: null,
      url: 'https://social.example/alice',
    },
    text: 'This is a test post. Hello.',
    translated_from: null,
    created_at: 0,
    stats: {
      replies: 3,
      reposts: 90,
      likes: 1000,
    },
    sensitivity: null,
    sensitivity_reason: null,
    quote: null,
    media: [],
  };

  const preview: UrlPreviewView = {
    url,
    title: 'Shipping the search crawl fix',
    description: 'How the indexer keeps results steady while older history is still loading.',
    site_name: 'Example Social',
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: post,
  };

  const media = (kind: PostMediaView['kind'], source: string): PostMediaView => ({
    kind,
    source,
    poster: null,
    mime: null,
    width: null,
    height: null,
    alt: null,
  });

  const previewWith = (obj: Partial<PostView>) => {
    return {
      ...preview,
      post: {
        ...post,
        ...obj,
      },
    } satisfies UrlPreviewView;
  };

  const { Story } = defineMeta({
    title: 'Room/Preview/Post link preview card',
    component: PostLinkPreview,
    tags: ['autodocs'],
    args: { url: preview.url, preview, mediaHidden: false, tunnel: false },
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

<Story
  name="With one image"
  args={{
    preview: previewWith({
      media: [media('image', 'https://social.example/image.png')],
    }),
  }}
/>

<Story
  name="With two images"
  args={{
    preview: previewWith({
      media: [
        media('image', 'https://social.example/image.png'),
        media('image', 'https://social.example/image.png'),
      ],
    }),
  }}
/>

<Story
  name="With four images"
  args={{
    preview: previewWith({
      media: [
        media('image', 'https://social.example/image.png'),
        media('image', 'https://social.example/image.png'),
        media('image', 'https://social.example/image.png'),
        media('image', 'https://social.example/image.png'),
      ],
    }),
  }}
/>

<Story
  name="With video"
  args={{
    preview: previewWith({
      media: [media('video', 'https://social.example/video.mp4')],
    }),
  }}
/>
