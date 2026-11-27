<script lang="ts" module>
  export interface ExplorerItem {
    id: string;
    label: string;
    title?: string;
    hint?: string;
    muted?: boolean;
  }

  export interface ExplorerGroup {
    id: string;
    label: string;
    items: ExplorerItem[];
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    label: string;
    groups: ExplorerGroup[];
    /** `undefined` shows the list alone. `null` opens the detail for a new item. */
    selected: string | null | undefined;
    query?: string;
    filterLabel: string;
    empty: string;
    noMatches: string;
    placeholder: string;
    loading?: boolean;
    detailLoading?: boolean;
    onSelect: (id: string) => void;
    onBack: () => void;
    toolbar?: Snippet;
    head?: Snippet;
    children: Snippet;
  }

  let {
    label,
    groups,
    selected,
    query = $bindable(''),
    filterLabel,
    empty,
    noMatches,
    placeholder,
    loading = false,
    detailLoading = false,
    onSelect,
    onBack,
    toolbar,
    head,
    children,
  }: Props = $props();

  let frame = $state<HTMLElement | null>(null);
  let listPane = $state<HTMLElement | null>(null);
  let detailHead = $state<HTMLElement | null>(null);
  let lastOpened: string | null = null;
  let shown: string | null | undefined = undefined;
  /** Matches the container query that puts both panes side by side. */
  const TWO_PANE_REM = 44;

  /** With one pane on screen the other's focused control vanishes, so focus follows the swap. */
  $effect(() => {
    const current = selected;
    const previous = shown;
    shown = current;
    const swapped = (previous === undefined) !== (current === undefined);
    void tick().then(() => {
      if (!frame) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const onePane = frame.clientWidth < TWO_PANE_REM * rem;
      if (current !== undefined && current !== null) lastOpened = current;
      if (!onePane || !swapped) return;
      if (current !== undefined) detailHead?.focus();
      else if (lastOpened !== null) focusItem(lastOpened);
    });
  });

  function focusItem(id: string): void {
    listPane?.querySelector<HTMLElement>(`[data-explorer-item="${CSS.escape(id)}"]`)?.focus();
  }
</script>

<div class="explorer-frame" bind:this={frame}>
  <div class={['explorer', { picked: selected !== undefined }]}>
    <div class="list-pane" bind:this={listPane}>
      <div class={['toolbar', { 'with-actions': toolbar }]}>
        <SearchField bind:value={query} label={filterLabel} />
        {@render toolbar?.()}
      </div>
      {#if loading && groups.length === 0}
        <div class="loading"><Spinner label={i18n.t('common.loading')} /></div>
      {:else if groups.length === 0}
        <p class="note">{query.trim() ? noMatches : empty}</p>
      {:else}
        <div class="list-frame">
          <div class="list" role="group" aria-label={label} {@attach scrollHint}>
            {#each groups as group (group.id)}
              <section>
                <h4 class="group">{group.label}</h4>
                <ul>
                  {#each group.items as item (item.id)}
                    <li>
                      <button
                        type="button"
                        class={['item', { muted: item.muted }]}
                        title={item.title ?? item.label}
                        data-explorer-item={item.id}
                        aria-pressed={selected === item.id}
                        onclick={() => onSelect(item.id)}
                      >
                        <span class="item-label">{item.label}</span>
                        {#if item.hint}<span class="item-hint">{item.hint}</span>{/if}
                      </button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="detail-pane">
      {#if selected === undefined}
        <p class="note placeholder">{placeholder}</p>
      {:else}
        <div class="detail-head" tabindex="-1" bind:this={detailHead}>
          <Button variant="ghost" size="small" class="back" onclick={onBack}>
            <ArrowLeftIcon class="mirror-rtl" aria-hidden="true" />
            {i18n.t('common.back')}
          </Button>
          {@render head?.()}
          {#if detailLoading}<Spinner small label={i18n.t('common.loading')} />{/if}
        </div>
        {@render children()}
      {/if}
    </div>
  </div>
</div>

<style>
  .explorer-frame {
    container-type: inline-size;
  }

  .explorer {
    display: grid;
    gap: var(--space-400);
  }

  .list-pane,
  .detail-pane {
    align-content: start;
    display: grid;
    gap: var(--space-300);
    min-width: 0;
  }

  .toolbar {
    align-items: center;
    display: grid;
    gap: var(--space-200);
  }

  .toolbar.with-actions {
    grid-auto-columns: auto;
    grid-auto-flow: column;
    grid-template-columns: minmax(0, 1fr);
  }

  .list-frame {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-inner);
    overflow: hidden;
    padding: var(--space-100);
  }

  .list {
    max-height: 32rem;
    overflow: auto;
  }

  .list ul {
    list-style: none;
    margin: 0;
    padding: 0 0 var(--space-100);
  }

  .group {
    background: var(--surface-container);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
    overflow: hidden;
    padding: var(--space-150) var(--space-300) var(--space-100);
    position: sticky;
    text-overflow: ellipsis;
    top: 0;
    white-space: nowrap;
  }

  .item {
    background: none;
    border: 0;
    border-radius: var(--radius-inner);
    color: inherit;
    cursor: pointer;
    display: grid;
    font: inherit;
    padding: var(--space-100) var(--space-300) var(--space-100) var(--space-500);
    text-align: start;
    width: 100%;
  }

  .item-label,
  .item-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .item.muted .item-label {
    color: var(--surface-var-on-container);
    text-decoration: line-through;
  }

  .item:hover {
    background: var(--surface-container-hover);
  }

  .item[aria-pressed='true'] {
    background: var(--surface-container-active);
  }

  .item[aria-pressed='true'] .item-label {
    color: var(--primary-main);
    font-weight: var(--font-weight-medium);
  }

  .item:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  @media (pointer: coarse) {
    .item {
      align-content: center;
      min-height: var(--target-hit);
    }
  }

  .loading {
    display: grid;
    min-height: 8rem;
    place-items: center;
  }

  .note {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .placeholder {
    background: var(--surface-container);
    border-radius: var(--radius);
    padding: var(--space-400);
  }

  .detail-head {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200) var(--space-300);
  }

  .detail-head:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  .detail-head > :global(.form-field) {
    flex: 1 1 16rem;
  }

  .explorer.picked .list-pane,
  .explorer:not(.picked) .detail-pane {
    display: none;
  }

  @container (min-width: 44rem) {
    .explorer {
      align-items: start;
      grid-template-columns: minmax(14rem, 2fr) minmax(0, 3fr);
    }

    .explorer.picked .list-pane,
    .explorer:not(.picked) .detail-pane {
      display: grid;
    }

    .detail-head :global(.back) {
      display: none;
    }

    .list {
      max-height: 36rem;
    }
  }
</style>
