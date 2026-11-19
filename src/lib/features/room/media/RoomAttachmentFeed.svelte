<script lang="ts" generics="K extends RoomAttachmentKind">
  import { onDestroy, type Snippet } from 'svelte';
  import type { RoomAttachmentKind } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { inlineKey } from '#lib/language.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { groupByMonth } from './attachment-groups';
  import { attachmentKey, type RoomAttachmentOf, type TileProps } from './room-attachments';
  import type { RoomAttachmentsPager } from './room-attachments-pager.svelte';

  interface Props {
    pager: RoomAttachmentsPager<K>;
    roomId: string;
    layout: 'grid' | 'rows';
    empty: string;
    item: Snippet<[RoomAttachmentOf<K>, TileProps | undefined]>;
  }

  let { pager, roomId, layout, empty, item }: Props = $props();

  const PREFETCH_BAND = '0px 0px 240px 0px';
  const GRID_COLUMNS = 3;

  let body = $state<HTMLElement>();
  let activeTile = $state<string | null>(null);

  let groups = $derived(groupByMonth(pager.items));
  let focusableTile = $derived(
    activeTile !== null && pager.items.some((entry) => attachmentKey(entry) === activeTile)
      ? activeTile
      : pager.items[0]
        ? attachmentKey(pager.items[0])
        : null
  );
  let showEmpty = $derived(
    pager.items.length === 0 && !pager.loading && !pager.failed && pager.exhausted
  );

  $effect(() => {
    pager.sync(roomId);
  });

  onDestroy(() => pager.dispose());

  function tileProps(entry: RoomAttachmentOf<K>): TileProps | undefined {
    if (layout !== 'grid') return undefined;
    const key = attachmentKey(entry);
    return {
      tabindex: focusableTile === key ? 0 : -1,
      'data-attachment-tile': '',
      onfocus: () => {
        activeTile = key;
      },
      onkeydown: tileKeydown,
    };
  }

  function tileKeydown(event: KeyboardEvent): void {
    const step =
      inlineKey(event.key) === 'ArrowRight'
        ? 1
        : inlineKey(event.key) === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? GRID_COLUMNS
            : event.key === 'ArrowUp'
              ? -GRID_COLUMNS
              : null;
    const current = event.currentTarget;
    if (step === null || !(current instanceof HTMLElement)) return;
    const tiles = Array.from(body?.querySelectorAll<HTMLElement>('[data-attachment-tile]') ?? []);
    const next = tiles[tiles.indexOf(current) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function nearEnd(node: HTMLElement): () => void {
    if (typeof IntersectionObserver === 'undefined') return () => {};
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) pager.loadMore();
      },
      { root: node.closest<HTMLElement>('.panel-body'), rootMargin: PREFETCH_BAND }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }
</script>

<p class="screen-reader-only" aria-live="polite">
  {pager.items.length > 0
    ? i18n.t('timeline.attachmentsLoaded', { count: pager.items.length })
    : ''}
</p>

<div class="attachments-body" aria-busy={pager.loading} bind:this={body}>
  {#if pager.items.length > 0}
    {#each groups as group (group.key)}
      {@const headingId = `attachments-${pager.kind}-${group.key}`}
      <section aria-labelledby={headingId}>
        <h3 class="group-heading" id={headingId}>{group.label}</h3>
        <ul class={layout === 'grid' ? 'media-grid' : 'attachment-list'}>
          {#each group.items as entry (attachmentKey(entry))}
            <li>{@render item(entry, tileProps(entry))}</li>
          {/each}
        </ul>
      </section>
    {/each}
  {:else if pager.loading}
    {#if layout === 'grid'}
      <div class="media-grid skeleton-grid" aria-hidden="true">
        {#each { length: 9 }, index (index)}
          <Skeleton class="media-skeleton" />
        {/each}
      </div>
    {:else}
      <div class="row-skeletons" aria-hidden="true">
        {#each { length: 5 }, index (index)}
          <div class="row-skeleton">
            <Skeleton class="row-skeleton-icon" />
            <span class="row-skeleton-lines">
              <Skeleton class="row-skeleton-line" />
              <Skeleton class="row-skeleton-line short" />
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {:else if showEmpty}
    <p class="attachments-status">{i18n.t(empty)}</p>
  {/if}

  {#if pager.failed}
    <div class="attachments-failure" role="alert">
      <p>{i18n.t('timeline.attachmentsFailed')}</p>
      <Button size="small" variant="secondary" onclick={() => pager.retry()}>
        {i18n.t('common.tryAgain')}
      </Button>
    </div>
  {:else if pager.loading && pager.items.length > 0}
    <div class="attachments-more"><Spinner small /></div>
  {:else if !pager.exhausted && !pager.loading}
    <div class="attachments-more" {@attach nearEnd}>
      <Button size="small" variant="secondary" onclick={() => pager.loadMore()}>
        {i18n.t('common.loadMore')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .attachments-body {
    padding-block-end: var(--space-300);
  }

  .attachments-body li > :global(*) {
    scroll-margin-block-start: var(--space-800);
  }

  .group-heading {
    background: var(--bg-container);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
    padding: var(--space-200) var(--space-400);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  ul {
    list-style: none;
    margin: 0;
  }

  .media-grid {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: 0 var(--space-300);
  }

  .skeleton-grid {
    padding-block-start: var(--space-300);
  }

  .media-grid :global(.media-skeleton) {
    aspect-ratio: 1 / 1;
  }

  .attachment-list {
    display: grid;
    padding: 0 var(--space-200);
  }

  .row-skeletons {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .row-skeleton {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .row-skeleton :global(.row-skeleton-icon) {
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .row-skeleton-lines {
    display: grid;
    flex: 1;
    gap: var(--space-100);
  }

  .row-skeleton :global(.row-skeleton-line) {
    height: 0.75rem;
  }

  .row-skeleton :global(.row-skeleton-line.short) {
    width: 40%;
  }

  .attachments-status {
    color: var(--surface-var-on-container);
    margin: 0;
    padding: var(--space-400);
  }

  .attachments-failure {
    display: grid;
    gap: var(--space-200);
    justify-items: start;
    padding: var(--space-400);
  }

  .attachments-failure p {
    margin: 0;
  }

  .attachments-more {
    display: flex;
    justify-content: center;
    padding: var(--space-300);
  }
</style>
