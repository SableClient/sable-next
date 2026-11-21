<script lang="ts">
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';

  import { i18n } from '#lib/i18n.js';
  import { ROOM_SORTS, ROOM_SORT_LABELS } from '#lib/rooms/room-sort.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuCheckItem from '#lib/ui/primitives/ActionMenuCheckItem.svelte';

  interface Props {
    sortKey: 'directSort' | 'roomSort';
  }

  let { sortKey }: Props = $props();

  let sort = $derived(preferences[sortKey]);
</script>

<ActionMenu label={i18n.t('nav.sortRooms')}>
  {#snippet trigger({ props })}
    <button
      {...props}
      type="button"
      class="room-sort-button selection-open"
      aria-label={`${i18n.t('nav.sortRooms')}: ${i18n.t(ROOM_SORT_LABELS[sort])}`}
      data-active={sort !== 'recent'}
    >
      <ArrowsDownUpIcon aria-hidden="true" />
    </button>
  {/snippet}
  {#each ROOM_SORTS as option (option)}
    <ActionMenuCheckItem
      checked={sort === option}
      label={i18n.t(ROOM_SORT_LABELS[option])}
      onSelect={() => {
        setPreference(sortKey, option);
      }}
    />
  {/each}
</ActionMenu>

<style>
  :global(.room-sort-button) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    height: 1.75rem;
    justify-content: center;
    opacity: var(--opacity-p300);
    padding: 0;
    width: 1.75rem;
  }

  :global(.room-sort-button:hover) {
    background: var(--bg-container-hover);
    color: var(--bg-on-container);
    opacity: 1;
  }

  :global(.room-sort-button[data-active='true']) {
    color: var(--primary-main);
    opacity: 1;
  }

  :global(.room-sort-button:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.room-sort-button svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }
</style>
