<script lang="ts">
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
  import FunnelIcon from 'phosphor-svelte/lib/FunnelIcon';

  import { i18n } from '#lib/i18n.js';
  import {
    MEMBERSHIP_FILTERS,
    MEMBERSHIP_FILTER_LABELS,
    MEMBER_SORTS,
    MEMBER_SORT_LABELS,
    type MembershipFilter,
  } from '#lib/rooms/member-listing.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    search: string;
    filter: MembershipFilter;
    membership: boolean;
  }

  let { search = $bindable(), filter = $bindable(), membership }: Props = $props();

  let sort = $derived(preferences.memberSort);
</script>

<div class="filters">
  {#if membership}
    <ActionMenu label={i18n.t('timeline.memberFilter')} align="start">
      {#snippet trigger({ props })}
        <button
          {...props}
          type="button"
          class="chip selection-open"
          aria-label={`${i18n.t('timeline.memberFilter')}: ${i18n.t(MEMBERSHIP_FILTER_LABELS[filter])}`}
        >
          <FunnelIcon aria-hidden="true" />
          <span>{i18n.t(MEMBERSHIP_FILTER_LABELS[filter])}</span>
        </button>
      {/snippet}
      {#each MEMBERSHIP_FILTERS as option (option)}
        <ActionMenuItem
          checked={filter === option}
          onSelect={() => {
            filter = option;
          }}
        >
          <span class="menu-check" aria-hidden="true">{filter === option ? '✓' : ''}</span>
          <span>{i18n.t(MEMBERSHIP_FILTER_LABELS[option])}</span>
        </ActionMenuItem>
      {/each}
    </ActionMenu>
  {/if}
  <ActionMenu label={i18n.t('timeline.memberSort')}>
    {#snippet trigger({ props })}
      <button
        {...props}
        type="button"
        class="chip selection-open"
        aria-label={`${i18n.t('timeline.memberSort')}: ${i18n.t(MEMBER_SORT_LABELS[sort])}`}
      >
        <span>{i18n.t(MEMBER_SORT_LABELS[sort])}</span>
        <ArrowsDownUpIcon aria-hidden="true" />
      </button>
    {/snippet}
    {#each MEMBER_SORTS as option (option)}
      <ActionMenuItem
        checked={sort === option}
        onSelect={() => {
          setPreference('memberSort', option);
        }}
      >
        <span class="menu-check" aria-hidden="true">{sort === option ? '✓' : ''}</span>
        <span>{i18n.t(MEMBER_SORT_LABELS[option])}</span>
      </ActionMenuItem>
    {/each}
  </ActionMenu>
</div>
<TextInput
  bind:value={search}
  class="member-search-input"
  placeholder={i18n.t('timeline.searchMembers')}
  aria-label={i18n.t('timeline.searchMembers')}
/>

<style>
  .filters {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
  }

  .filters :global(.chip) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    min-height: 1.75rem;
    padding: 0 var(--space-150);
  }

  .filters :global(.chip:hover) {
    background: var(--bg-container-hover);
    color: var(--bg-on-container);
  }

  .filters :global(.chip:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .filters :global(.chip svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .filters :global(.chip:first-child svg) {
    color: var(--primary-main);
  }

  :global(.member-search-input) {
    --form-control-container: var(--surface-container);
    --form-control-container-line: var(--surface-container-line);
    --form-control-color: var(--surface-on-container);

    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    min-height: 2.25rem;
    padding: 0 var(--space-300);
    width: 100%;
  }
</style>
