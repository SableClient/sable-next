<script lang="ts">
  import type { MemberView } from '#src/generated/MemberView';
  import { Dialog, DropdownMenu } from 'bits-ui';
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
  import FunnelIcon from 'phosphor-svelte/lib/FunnelIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import MemberIdentityRow from './MemberIdentityRow.svelte';
  import {
    MEMBERSHIP_FILTERS,
    MEMBERSHIP_FILTER_LABELS,
    MEMBER_SORTS,
    MEMBER_SORT_LABELS,
    groupMembers,
    matchesFilter,
    memberName,
    membershipFor,
    type MembershipFilter,
  } from './member-listing';
  import { powerTag } from './power-tags';
  import type { PowerLevelTagMap } from './settings/power-level-tags';

  import '#lib/ui/primitives/menu.css';

  interface Props {
    members: readonly MemberView[];
    loading: boolean;
    modal?: boolean;
    compact?: boolean;
    searchable?: boolean;
    title?: string;
    powerTags?: PowerLevelTagMap;
    loadMembership?: ((membership: MemberView['membership']) => Promise<MemberView[]>) | null;
    onClose: () => void;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    members,
    loading,
    modal = false,
    compact = false,
    searchable = true,
    title = $i18n.t('timeline.members'),
    powerTags = {},
    loadMembership = null,
    onClose,
    onMemberProfile,
  }: Props = $props();
  let search = $state('');
  let filter = $state<MembershipFilter>('join');
  let fetched = $state.raw<MemberView[]>([]);
  let fetching = $state(false);
  let generation = 0;

  let sort = $derived(preferences.memberSort);
  let listed = $derived(filter === 'join' ? members : fetched);
  let matching = $derived(listed.filter((member) => matchesFilter(member, filter)));
  let searched = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return matching;
    return matching.filter((member) => memberName(member).toLocaleLowerCase().includes(query));
  });
  let groups = $derived(groupMembers(searched, sort));
  let busy = $derived(filter === 'join' ? loading : fetching);

  $effect(() => {
    const load = loadMembership;
    const membership = membershipFor(filter);
    if (filter === 'join' || !load) return;

    const run = ++generation;
    fetching = true;
    void load(membership)
      .then((next) => {
        if (run === generation) fetched = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] members unavailable', error);
        if (run === generation) fetched = [];
      })
      .finally(() => {
        if (run === generation) fetching = false;
      });
  });
</script>

<aside class={['members-drawer', { compact }]} aria-label={title}>
  <header>
    <div>
      {#if modal}
        <Dialog.Title class="title">{title}</Dialog.Title>
      {:else}
        <h2 class="title">{title}</h2>
      {/if}
      <p>{$i18n.t('timeline.memberCount', { count: members.length })}</p>
    </div>
    {#if modal}
      <Dialog.Close
        class="sable-button sable-button-ghost sable-icon-button sable-icon-button-small"
        aria-label={$i18n.t('timeline.closeMembers')}><XIcon /></Dialog.Close
      >
    {:else}
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('timeline.closeMembers')}
        onclick={onClose}><XIcon /></IconButton
      >
    {/if}
  </header>

  {#if searchable}
    <div class="controls">
      <div class="filters">
        {#if loadMembership}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger class="chip" aria-label={$i18n.t('timeline.memberFilter')}>
              <FunnelIcon aria-hidden="true" />
              <span>{$i18n.t(MEMBERSHIP_FILTER_LABELS[filter])}</span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content class="sable-menu" side="bottom" align="start" sideOffset={4}>
              {#each MEMBERSHIP_FILTERS as option (option)}
                <DropdownMenu.Item
                  class="sable-menu-item"
                  aria-checked={filter === option}
                  onSelect={() => {
                    filter = option;
                  }}
                >
                  <span class="sable-menu-check" aria-hidden="true"
                    >{filter === option ? '✓' : ''}</span
                  >
                  {$i18n.t(MEMBERSHIP_FILTER_LABELS[option])}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="chip" aria-label={$i18n.t('timeline.memberSort')}>
            <span>{$i18n.t(MEMBER_SORT_LABELS[sort])}</span>
            <ArrowsDownUpIcon aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="sable-menu" side="bottom" align="end" sideOffset={4}>
            {#each MEMBER_SORTS as option (option)}
              <DropdownMenu.Item
                class="sable-menu-item"
                aria-checked={sort === option}
                onSelect={() => {
                  setPreference('memberSort', option);
                }}
              >
                <span class="sable-menu-check" aria-hidden="true">{sort === option ? '✓' : ''}</span
                >
                {$i18n.t(MEMBER_SORT_LABELS[option])}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <TextInput
        bind:value={search}
        class="member-search-input"
        placeholder={$i18n.t('timeline.searchMembers')}
        aria-label={$i18n.t('timeline.searchMembers')}
      />
    </div>
  {/if}

  {#if busy}
    <p class="status">{$i18n.t('timeline.loadingMembers')}</p>
  {:else}
    {#if groups.length > 0}
      <div class="member-groups">
        {#each groups as group (group.level)}
          {@const tag = powerTag(group.level, $i18n.t, powerTags)}
          <h3 class="group-label" style:color={tag.color ?? undefined}>{tag.name}</h3>
          <ul>
            {#each group.members as member (member.user_id)}
              <li>
                <MemberIdentityRow
                  class="member"
                  userId={member.user_id}
                  {members}
                  onProfile={onMemberProfile}
                />
              </li>
            {/each}
          </ul>
        {/each}
      </div>
    {:else if search.trim() !== ''}
      <p class="status">{$i18n.t('timeline.noMembersFound')}</p>
    {:else}
      <p class="status">
        {$i18n.t('timeline.noMembersForFilter', {
          filter: $i18n.t(MEMBERSHIP_FILTER_LABELS[filter]),
        })}
      </p>
    {/if}
  {/if}
</aside>

<style>
  .members-drawer {
    background: var(--sable-bg-container);
    box-shadow: var(--shadow-dialog);
    display: flex;
    flex-direction: column;
    inset: 0 0 0 auto;
    max-width: min(22rem, 85%);
    position: absolute;
    width: 100%;
    z-index: 2;
  }

  .members-drawer.compact {
    box-shadow: none;
    inset: auto;
    max-width: none;
    position: static;
    width: 100%;
  }

  header {
    align-items: center;
    background: var(--sable-bg-container);
    border-bottom: var(--border-width) solid var(--sable-surface-var-container);
    display: flex;
    justify-content: space-between;
    min-height: 3.75rem;
    padding: var(--space-200) var(--space-300) var(--space-200) var(--space-400);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .title,
  header p {
    margin: 0;
  }

  .title {
    font-size: var(--font-size-body);
  }

  header p,
  .status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  header p {
    line-height: var(--line-height-small);
  }

  .status {
    margin: 0;
    padding: var(--space-300) var(--space-400);
  }

  .controls {
    background: var(--sable-bg-container);
    display: grid;
    gap: var(--space-200);
    padding: var(--space-300);
    position: sticky;
    top: 3.75rem;
    z-index: 1;
  }

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
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    min-height: 1.75rem;
    padding: 0 var(--space-150);
  }

  .filters :global(.chip:hover) {
    background: var(--sable-surface-container);
    color: var(--sable-bg-on-container);
  }

  .filters :global(.chip:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .filters :global(.chip svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .filters :global(.chip:first-child svg) {
    color: var(--sable-primary-main);
  }

  :global(.member-search-input) {
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    min-height: 2.5rem;
    padding: 0 var(--space-300);
    width: 100%;
  }

  .member-groups {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-100) var(--space-200) var(--space-200);
  }

  .group-label {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-small);
    margin: 0;
    padding: var(--space-200) var(--space-200) var(--space-100);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  :global(.member-identity-row.member) {
    min-height: 3rem;
    padding: 0 var(--space-200);
  }

  @media (width >= 48rem) {
    .members-drawer:not(.compact) {
      border-left: var(--border-width) solid var(--sable-surface-container-line);
      box-shadow: none;
      flex: 0 0 16.625rem;
      inset: auto;
      max-width: 22rem;
      min-width: 12rem;
      position: relative;
      width: 16.625rem;
    }
  }
</style>
