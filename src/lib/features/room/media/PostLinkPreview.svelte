<script lang="ts">
  import ChatDotsIcon from 'phosphor-svelte/lib/ChatDotsIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import RepeatIcon from 'phosphor-svelte/lib/RepeatIcon';
  import { SvelteSet } from 'svelte/reactivity';

  import type {
    PostMediaView,
    PostSensitivityView,
    PostView,
    UrlPreviewView,
  } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import MediaContent from '#lib/ui/MediaContent.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { formatMessageTimestamp } from '#lib/ui/date-time.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  import { GIF_PLAYBACK } from './link-preview.js';

  interface Props {
    url: string;
    preview: UrlPreviewView;
    mediaHidden: boolean;
  }

  let { url, preview, mediaHidden }: Props = $props();
  let post = $derived(preview.post);
  const revealed = new SvelteSet<'post' | 'quote'>();

  const warnings = {
    graphic: 'timeline.postGraphic',
    inappropriate: 'timeline.postInappropriate',
    spoiler: 'timeline.postSpoiler',
  } as const satisfies Record<PostSensitivityView, string>;
</script>

{#snippet author(post: PostView, size: number)}
  <span class="post-author">
    {#if post.author.avatar && !mediaHidden}
      <MediaImage
        class="post-avatar"
        source={post.author.avatar}
        alt=""
        width={size}
        height={size}
      />
    {/if}
    {#if post.author.name}<span class="post-name">{post.author.name}</span>{/if}
    {#if post.author.handle}<span class="post-handle">@{post.author.handle}</span>{/if}
  </span>
{/snippet}

{#snippet media(items: PostMediaView[])}
  {#if items.length > 0 && !mediaHidden}
    <div class={['post-media', { grid: items.length > 1 }]}>
      {#each items as item, index (index)}
        {#if item.kind === 'image'}
          <MediaImage
            source={item.source}
            alt={item.alt ?? ''}
            width={items.length > 1 ? 200 : 400}
            height={items.length > 1 ? 200 : 300}
            intrinsicWidth={item.width}
            intrinsicHeight={item.height}
            mime={item.mime}
            href={url}
          />
        {:else}
          <MediaContent
            source={item.source}
            mime={item.mime ?? 'video/mp4'}
            filename={url}
            kind="video"
            width={item.width}
            height={item.height}
            playback={item.kind === 'gif' ? GIF_PLAYBACK : null}
          />
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet content(note: PostView, key: 'post' | 'quote')}
  {#if note.sensitivity && !revealed.has(key)}
    <Button class="post-warning" onclick={() => revealed.add(key)}>
      {note.sensitivity_reason ?? i18n.t(warnings[note.sensitivity])} — {i18n.t(
        'timeline.showPost'
      )}
    </Button>
  {:else}
    {#if note.text}<p class="post-text">{note.text}</p>{/if}
    {@render media(note.media)}
  {/if}
{/snippet}

{#if post}
  <div class="post-preview">
    <a class="post-header" href={url} target="_blank" rel="external noopener noreferrer">
      {#if preview.site_name}<span class="post-site">{preview.site_name}</span>{/if}
      {@render author(post, 24)}
    </a>
    {@render content(post, 'post')}
    {#if post.quote}
      {@const quote = post.quote}
      <div class="post-quote">
        {@render author(quote, 20)}
        {@render content(quote, 'quote')}
      </div>
    {/if}
    {#if post.stats || post.created_at !== null}
      <div class="post-footer">
        {#if post.stats}
          <span class="post-stats">
            {#if post.stats.replies !== null}
              <span
                class="post-stat"
                title={i18n.t('timeline.postReplies', { count: post.stats.replies })}
                ><ChatDotsIcon aria-hidden="true" />{post.stats.replies}</span
              >
            {/if}
            {#if post.stats.reposts !== null}
              <span
                class="post-stat"
                title={i18n.t('timeline.postReposts', { count: post.stats.reposts })}
                ><RepeatIcon aria-hidden="true" />{post.stats.reposts}</span
              >
            {/if}
            {#if post.stats.likes !== null}
              <span
                class="post-stat"
                title={i18n.t('timeline.postLikes', { count: post.stats.likes })}
                ><HeartIcon aria-hidden="true" />{post.stats.likes}</span
              >
            {/if}
          </span>
        {/if}
        {#if post.created_at !== null}
          <time class="post-time" datetime={new Date(post.created_at).toISOString()}
            >{formatMessageTimestamp(post.created_at)}</time
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .post-preview {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    margin-top: var(--space-100);
    max-width: var(--timeline-media-max);
    overflow: hidden;
    padding: var(--space-200) var(--space-250);
  }

  .post-header {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    text-decoration: none;
  }

  .post-site {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-transform: uppercase;
  }

  .post-author {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .post-author :global(.post-avatar) {
    border-radius: var(--radius);
    flex: none;
  }

  .post-name {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .post-header:hover .post-name {
    text-decoration: underline;
  }

  .post-handle {
    color: var(--surface-var-on-container);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .post-text {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .post-media.grid {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .post-quote {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    padding: var(--space-200);
  }

  .post-footer {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    justify-content: space-between;
  }

  .post-stats {
    display: flex;
    gap: var(--space-300);
  }

  .post-stat {
    align-items: center;
    display: flex;
    gap: var(--space-100);
  }
</style>
