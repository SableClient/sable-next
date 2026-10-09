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
    type ApEmbed,
    type ImageEmbed,
    type VideoEmbed,
    parseAtUri,
  } from './bluesky';

  import LinkPreviewCard from '../LinkPreviewCard.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { formatMessageTimestamp } from '#lib/ui/date-time.js';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  let record = $derived(parseBlueskyLink(url));
  let authorHandle = $derived<string | null>(null);
  let details = $state<BlueskyPostDetails | null>(null);
  let profile = $state<BlueskyProfileDetails | null>(null);
  let likes = $state<number | null>(null);
  let reposts = $state<number | null>(null);
  let comments = $state<number | null>(null);
  let quote = $state<BlueskyPostDetails | null>(null);
  let quoteProfile = $state<BlueskyProfileDetails | null>(null);

  $effect(() => {
    const repo = record?.repo;
    const key = record?.key;

    details = null;
    if (repo === undefined || key === undefined) return;

    let cancelled = false;
    void resolveMiniDoc(repo).then((miniDoc) => {
      if (!miniDoc) return null;
      const { did, pds, handle } = miniDoc;
      authorHandle = handle;

      void fetchPostDetails(pds, did, key).then((result) => {
        if (!cancelled) details = result;
        console.info(details);

        let record;
        if (details?.value.embed?.$type === 'app.bsky.embed.recordWithMedia') {
          record = details.value.embed.record.record;
        } else if (details?.value.embed?.$type === 'app.bsky.embed.record') {
          record = details.value.embed.record;
        }
        // if we have a quote post we have to do all of this again. sorry.
        if (record) {
          const doc = parseAtUri(record.uri);
          if (!doc) return null;
          void resolveMiniDoc(doc.repo).then((miniDoc) => {
            if (!miniDoc) return null;
            const { did: quotedid, pds: quotepds } = miniDoc;

            if (doc.key === undefined) return null;
            void fetchPostDetails(quotepds, quotedid, doc.key).then((result) => {
              if (!cancelled) quote = result;
            });

            void fetchProfile(quotepds, quotedid).then((result) => {
              if (!cancelled) quoteProfile = result;
            });
          });
        }
      });

      void fetchProfile(pds, did).then((result) => {
        if (!cancelled) profile = result;
      });

      void getPostRelationCount(did, key).then((result) => {
        if (!cancelled) {
          likes = result?.likes ?? null;
          comments = result?.comments ?? null;
          reposts = result?.reposts ?? null;
        }
      });
    });

    return () => {
      cancelled = true;
    };
  });
</script>

{#snippet embedVideo(embed: VideoEmbed)}
  {@const src = embed.video['moe.sable.blob'] && URL.createObjectURL(embed.video['moe.sable.blob'])}

  {#if embed.presentation === 'default'}
    <video
      controls
      class="embed-solo-image"
      {src}
      title={embed.alt}
      width={embed.aspectRatio.width}
      height={embed.aspectRatio.height}><track kind="captions" /></video
    >
  {:else if embed.presentation === 'gif'}
    <video
      autoplay
      loop
      muted
      class="embed-solo-image"
      {src}
      title={embed.alt}
      width={embed.aspectRatio.width}
      height={embed.aspectRatio.height}><track kind="captions" /></video
    >
  {/if}
{/snippet}

{#snippet embedImage(embed: ImageEmbed)}
  {#if embed.images.length === 1}
    {@const image = embed.images[0]}

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
      {#each embed.images as image (image.image.ref.$link)}
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
{/snippet}
{#snippet embedQuote()}
  <div class="embed-quote-record">
    {#if quoteProfile && quote}
      {@const src =
        quoteProfile.value.avatar['moe.sable.blob'] &&
        URL.createObjectURL(quoteProfile.value.avatar['moe.sable.blob'])}

      <span class="bsky-author">
        <img class="author-avatar" {src} alt="avatar" height="24" width="24" />
        <span class="displayname">{quoteProfile.value.displayName}</span>
        <span class="handle">{authorHandle}</span></span
      >
      <p class="post-content">{quote.value.text}</p>

      {#if quote.value.embed}
        {#if quote.value.embed.$type === 'app.bsky.embed.recordWithMedia'}
          {@render embed(quote.value.embed.media)}
        {:else if quote.value.embed.$type !== 'app.bsky.embed.record'}
          {@render embed(quote.value.embed)}
        {/if}
      {/if}
    {:else}
      <Spinner />
    {/if}
  </div>
{/snippet}
{#snippet embed(e: ApEmbed)}
  <!--
      TODO: support other embed types e.g
      - app.bsky.embed.gallery (see https://github.com/snarfed/bridgy-fed/issues/2504)
      - app.bsky.embed.external (link to a gif site eg klipy (oh no))
    -->
  {#if e.$type === 'app.bsky.embed.images'}
    {@render embedImage(e)}
  {:else if e.$type === 'app.bsky.embed.video'}
    {@render embedVideo(e)}
  {:else if e.$type === 'app.bsky.embed.record'}
    {@render embedQuote()}
  {:else if e.$type === 'app.bsky.embed.recordWithMedia'}
    {@render embed(e.media)}
    {@render embed(e.record)}
  {/if}
{/snippet}
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
          <span class="displayname">{profile.value.displayName}</span>
          <span class="handle">{authorHandle}</span></span
        >
      {:else}
        <Spinner />
      {/if}
    </a>
    <div class="post-body">
      <p class="post-content">{details.value.text}</p>

      {#if details.value.embed}
        {@render embed(details.value.embed)}
      {/if}
    </div>
    <div class="post-footer">
      <div class="embed-relations">
        <span class="embed-relation"><ChatDotsIcon /> {comments ?? '?'}</span>
        <span class="embed-relation"><RepeatIcon /> {reposts ?? '?'}</span>
        <span class="embed-relation"><HeartIcon /> {likes ?? '?'}</span>
      </div>
      <div class="timestamp">
        {formatMessageTimestamp(new Date(details.value.createdAt).getTime())}
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

  .handle {
    font-weight: normal;

    &::before {
      content: '@';
    }
  }

  .post-body {
    padding-inline: var(--space-200);
  }

  .post-content {
    margin: 0;
    margin-bottom: var(--space-200);
  }

  .post-footer {
    align-items: center;
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    padding: var(--space-200) var(--space-250);
  }

  .embed-relations {
    display: flex;
    flex-direction: row;
    gap: var(--space-300);
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
    max-width: 100%;
    width: auto;
  }

  .embed-quote-record {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    margin-top: var(--space-100);
    overflow: hidden;
    padding: var(--space-200);
    padding-bottom: 0;
  }
</style>
