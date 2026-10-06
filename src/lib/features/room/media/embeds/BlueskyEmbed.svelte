<script lang="ts">
  import ChatDotsIcon from 'phosphor-svelte/lib/ChatDotsIcon';
  import RepeatIcon from 'phosphor-svelte/lib/RepeatIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';

  import type { UrlPreviewView } from '#src/generated/protocol';

  import {
    parseBlueskyLink,
    fetchPostDetails,
    fetchProfile,
    type BlueskyPostDetails,
    type BlueskyProfileDetails,
    resolveMiniDoc,
    getPostRelationCount,
  } from './bluesky';

  import LinkPreviewCard from '../LinkPreviewCard.svelte';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  let record = $derived(parseBlueskyLink(url));
  let details = $state<BlueskyPostDetails | null>(null);
  let profile = $state<BlueskyProfileDetails | null>(null);
  let likes = $state<number | null>(null);
  let reposts = $state<number | null>(null);
  let comments = $state<number | null>(null);

  $effect(() => {
    const repo = record?.repo;
    const key = record?.key;

    details = null;
    if (repo === undefined || key === undefined) return;

    let cancelled = false;
    void resolveMiniDoc(repo).then((miniDoc) => {
      if (!miniDoc) return null;
      const { did, pds } = miniDoc;

      void fetchPostDetails(pds, did, key).then((result) => {
        if (!cancelled) details = result;
      });

      void fetchProfile(pds, did).then((result) => {
        if (!cancelled) profile = result;
      });

      void getPostRelationCount(did, key, 'app.bsky.feed.like').then((result) => {
        if (!cancelled) likes = result;
      });
      void getPostRelationCount(did, key, 'app.bsky.feed.post').then((result) => {
        if (!cancelled) comments = result;
      });
      void getPostRelationCount(did, key, 'app.bsky.feed.repost').then((result) => {
        if (!cancelled) reposts = result;
      });
    });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if details}
  <div class="bsky-embed">
    <a class="bsky-header" href={url} target="_blank" rel="noopener noreferrer">
      <span class="bsky-site">BlueSky</span>
      {#if profile}
        {@const src =
          profile.value.avatar['moe.sable.blob'] &&
          URL.createObjectURL(profile.value.avatar['moe.sable.blob'])}

        <span class="bsky-author">
          <img class="author-avatar" {src} alt="avatar" height="24" width="24" />
          {profile.value.displayName}</span
        >
      {/if}
    </a>
    <div class="post-body">
      <p class="post-content">{details.value.text}</p>

      <!--
              TODO: support other embed types e.g
              - app.bsky.embed.gallery (see https://github.com/snarfed/bridgy-fed/issues/2504)
            -->
      {#if details.value.embed && details.value.embed?.$type === 'app.bsky.embed.images'}
        {#if details.value.embed.images.length === 1}
          {@const image = details.value.embed.images[0]}

          {@const src =
            image.image['moe.sable.blob'] && URL.createObjectURL(image.image['moe.sable.blob'])}

          <img
            class="embed-solo-image"
            {src}
            alt={image.alt ?? 'No alt text...'}
            width={image.aspectRatio.width}
            height={image.aspectRatio.height}
          />
        {:else}
          <div class="embed-images">
            {#each details.value.embed.images as image (image.image.ref.$link)}
              {@const src =
                image.image['moe.sable.blob'] && URL.createObjectURL(image.image['moe.sable.blob'])}

              {#if src}
                <!-- TODO: it would be hard because these aren't MediaImages but being able to click them to open in full view would be awesome -->
                <img
                  class="embed-image"
                  {src}
                  alt={image.alt ?? 'No alt text...'}
                  width={image.aspectRatio.width}
                  height={image.aspectRatio.height}
                />
              {/if}
            {/each}
          </div>
        {/if}
      {:else}
        <!-- unsupported embed type/no embed -->
      {/if}

      <div class="embed-relations">
        <span class="embed-relation"><ChatDotsIcon /> {comments ?? '?'}</span>
        <span class="embed-relation"><RepeatIcon /> {reposts ?? '?'}</span>
        <span class="embed-relation"><HeartIcon /> {likes ?? '?'}</span>
      </div>
    </div>
  </div>
{:else if details === null}
  <LinkPreviewCard {url} {encrypted} {bundled} />
{/if}

<style>
  .bsky-embed {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    max-width: var(--timeline-media-max);
    overflow: hidden;
  }

  .bsky-header {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-250);
    text-decoration: none;
  }

  .bsky-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .bsky-author {
    display: flex;
    flex-direction: row;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    justify-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bsky-header:hover .bsky-author {
    text-decoration: underline;
  }

  .author-avatar {
    border-radius: var(--radius);
  }

  .post-body {
    padding-inline: var(--space-200);
  }

  .post-content {
    margin: 0;
    margin-bottom: var(--space-200);
  }

  .embed-relations {
    display: flex;
    flex-direction: row;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-250);
  }

  .embed-relation {
    align-items: center;
    display: flex;
    flex-direction: row;
    gap: var(--space-100);
  }

  .embed-images {
    align-content: flex-start;
    align-items: stretch;
    display: flex;
    flex-direction: row;
    gap: var(--space-100);

    & .embed-image {
      aspect-ratio: 1 / 1;
      display: block;
      height: 100%;
      object-fit: cover;
      object-position: left 50% top 50%;
      width: 100%;
    }
  }

  .embed-solo-image {
    display: block;
    margin: 0 auto;
    max-height: 20rem;
    width: auto;
  }
</style>
