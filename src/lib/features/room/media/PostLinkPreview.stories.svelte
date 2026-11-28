<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import type { UrlPreviewView, PostView, PostMediaView } from '#src/generated/protocol';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import {
    IMAGE_SIZES,
    mockImage,
    mockImages,
    type ImageSize,
  } from '../../../../../.storybook/mock-media';

  import PostLinkPreview from './PostLinkPreview.svelte';

  const url = 'https://social.example/alice/post/f00b4r';
  const imageUrl = mockImage(800, 600);

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
    image: imageUrl,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: post,
  };

  const media = (
    kind: PostMediaView['kind'],
    source: string,
    width: number | null = null,
    height: number | null = null
  ): PostMediaView => ({
    kind,
    source,
    poster: null,
    mime: null,
    width,
    height,
    alt: null,
  });

  const images = (sizes: ImageSize[]) =>
    mockImages(sizes).map((image) => media('image', image.source, image.width, image.height));

  const X_SIZES = [IMAGE_SIZES.wide, IMAGE_SIZES.square, IMAGE_SIZES.tall];
  const xPost = (sizes: ImageSize[]): UrlPreviewView => ({
    ...preview,
    url: 'https://x.com/alice/status/1861234567890123456',
    site_name: 'X',
    post: { ...post, text: `A post with ${String(sizes.length)} images.`, media: images(sizes) },
  });
  const xPostWith = (count: number) =>
    xPost(Array.from({ length: count }, (_, index) => X_SIZES[index % X_SIZES.length]));

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
    title: 'Message/Preview/Post link preview card',
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
  name="With image"
  args={{
    preview: previewWith({
      media: [media('image', imageUrl)],
    }),
  }}
/>

<Story
  name="With tall image"
  args={{
    preview: previewWith({
      media: [media('image', mockImage(100, 400), 100, 400)],
    }),
  }}
/>

<Story
  name="With wide image"
  args={{
    preview: previewWith({
      media: [media('image', mockImage(400, 100), 400, 100)],
    }),
  }}
/>

<Story
  name="With square image"
  args={{
    preview: previewWith({
      media: [media('image', mockImage(200, 200), 200, 200)],
    }),
  }}
/>

<Story
  name="With two images"
  args={{
    preview: previewWith({
      media: [media('image', imageUrl), media('image', imageUrl)],
    }),
  }}
/>

<Story
  name="With three images"
  args={{
    preview: previewWith({
      media: [media('image', imageUrl), media('image', imageUrl), media('image', imageUrl)],
    }),
  }}
/>

<Story
  name="With four images"
  args={{
    preview: previewWith({
      media: [
        media('image', imageUrl),
        media('image', imageUrl),
        media('image', imageUrl),
        media('image', imageUrl),
      ],
    }),
  }}
/>

<Story name="X post, 1 image" args={{ preview: xPostWith(1) }} />

<Story name="X post, 2 images" args={{ preview: xPostWith(2) }} />

<Story name="X post, 3 images" args={{ preview: xPostWith(3) }} />

<Story name="X post, 4 images" args={{ preview: xPostWith(4) }} />

<Story name="X post, 6 images" args={{ preview: xPostWith(6) }} />

<Story name="X post, 8 images" args={{ preview: xPostWith(8) }} />

<Story name="X post, 10 images" args={{ preview: xPostWith(10) }} />

<Story name="X post, 20 images" args={{ preview: xPostWith(20) }} />

<Story
  name="X post, narrow tall slices"
  args={{
    preview: xPost([
      { width: 120, height: 1600 },
      { width: 180, height: 1600 },
      { width: 240, height: 1400 },
      { width: 90, height: 1200 },
      { width: 300, height: 1800 },
    ]),
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
