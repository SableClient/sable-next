<script lang="ts">
  import { clamp } from '#lib/clamp.js';
  import { Dialog } from 'bits-ui';
  import type { ComponentProps } from 'svelte';
  import { innerWidth } from 'svelte/reactivity/window';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { currentLocale, i18n } from '#lib/i18n.js';
  import { panelIn, panelOut, usePanelStage } from '#lib/ui/motion.js';
  import { readText, writeText } from '#lib/platform/local-json.js';
  import { MEMBERSHIP_FILTER_LABELS, type MembershipFilter } from '#lib/rooms/member-listing.js';
  import PanelBody from '#lib/ui/primitives/PanelBody.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';

  import MemberList from './MemberList.svelte';
  import MemberListControls from './MemberListControls.svelte';

  interface Props extends Omit<
    ComponentProps<typeof MemberList>,
    'count' | 'resultCount' | 'search' | 'filter'
  > {
    searchable?: boolean;
    modal?: boolean;
    compact?: boolean;
    title?: string;
  }

  let {
    searchable = true,
    modal = false,
    compact = false,
    title = i18n.t('timeline.members'),
    ...list
  }: Props = $props();
  const stage = usePanelStage();

  let count = $state(0);
  let resultCount = $state<number | null>(null);
  let search = $state('');
  let filter = $state<MembershipFilter>('join');
  let width = $state<number | null>(null);

  const WIDTH_STORAGE_KEY = 'sable-members-drawer-width';
  const DEFAULT_WIDTH = 266;
  const MIN_WIDTH = 224;
  const MAX_WIDTH = 640;
  let currentWidth = $derived(width ?? DEFAULT_WIDTH);
  let maxWidth = $derived(clamp((innerWidth.current ?? Infinity) / 2, MIN_WIDTH, MAX_WIDTH));

  function resize(next: number): void {
    width = clamp(next, MIN_WIDTH, maxWidth);
  }

  const storedWidth = Number.parseInt(readText(WIDTH_STORAGE_KEY) ?? '', 10);
  if (Number.isFinite(storedWidth)) resize(storedWidth);

  let countLabel = $derived(
    count === 0 && list.loading ? '' : i18n.t('timeline.memberCount', { count })
  );
  let countNumber = $derived(new Intl.NumberFormat(currentLocale()).format(count));
  let resultLabel = $derived.by(() => {
    if (resultCount === null) return '';
    if (search.trim() !== '') return i18n.t('timeline.memberResults', { count: resultCount });
    if (filter !== 'join') {
      const total = new Intl.NumberFormat(currentLocale()).format(resultCount);
      return `${i18n.t(MEMBERSHIP_FILTER_LABELS[filter])} · ${total}`;
    }
    return '';
  });
</script>

<aside
  in:panelIn|global={{ modal, stage }}
  out:panelOut|global={{ modal, stage }}
  class={['members-drawer', { compact }]}
  aria-label={title}
  data-focus-region="panel"
  style:width={width === null ? undefined : `${width}px`}
>
  {#if !modal && !compact}
    <ResizeHandle
      value={currentWidth}
      min={MIN_WIDTH}
      max={maxWidth}
      label={title}
      grow="left"
      step={16}
      shiftStep={64}
      homeEnd
      onResize={resize}
      onCommit={() => {
        if (width !== null) writeText(WIDTH_STORAGE_KEY, String(width));
      }}
    />
  {/if}
  {#if modal}
    <PanelHeader {modal} {title}>
      {#snippet suffix()}
        {#if countLabel}
          <span class="header-count">
            <span aria-hidden="true">{countNumber}</span>
            <span class="screen-reader-only">{countLabel}</span>
          </span>
        {/if}
        <Dialog.Close
          class="btn btn-ghost icon-button icon-button-small"
          aria-label={i18n.t('timeline.closeMembers')}><XIcon /></Dialog.Close
        >
      {/snippet}
    </PanelHeader>
  {:else}
    <h2 class="screen-reader-only">{title}</h2>
  {/if}

  <PanelBody toolbar={searchable ? controls : undefined}>
    <MemberList {...list} {search} {filter} bind:count bind:resultCount />
  </PanelBody>

  {#if !modal}
    <footer class="members-status">
      <span class="member-total">{countLabel}</span>
      {#if resultLabel}<span class="member-results">{resultLabel}</span>{/if}
    </footer>
  {/if}
</aside>

{#snippet controls()}
  <MemberListControls bind:search bind:filter membership={!!list.loadMembership} />
{/snippet}

<style>
  .members-drawer {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    box-shadow: var(--shadow-dialog);
    color: var(--bg-on-container);
    display: flex;
    flex-direction: column;
    inset-block: 0;
    inset-inline: auto 0;
    max-width: min(22rem, 85%);
    position: absolute;
    width: 100%;
    z-index: 2;
  }

  .header-count {
    align-items: center;
    color: var(--surface-var-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .members-status {
    align-items: center;
    border-block-start: var(--border-width) solid var(--bg-container-line);
    color: var(--surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: space-between;
    min-height: 2rem;
    padding: var(--space-100) var(--space-300);
  }

  .member-results {
    font-variant-numeric: tabular-nums;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-total {
    font-variant-numeric: tabular-nums;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .members-drawer :global(.resize-handle) {
    display: none;
    inset-inline-start: 0;
    z-index: 3;
  }

  .members-drawer.compact {
    box-shadow: none;
    inset: auto;
    max-width: none;
    position: static;
    width: 100%;
  }

  @media (width > 70.25rem) {
    .members-drawer:not(.compact) {
      border-inline-start: var(--border-width) solid var(--surface-container-line);
      box-shadow: none;
      flex: 0 0 auto;
      inset: auto;
      max-width: min(40rem, 50vw);
      position: relative;
      width: 16.625rem;
    }

    .members-drawer :global(.resize-handle) {
      display: block;
    }
  }
</style>
