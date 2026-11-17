<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUpIcon';
  import FunnelIcon from 'phosphor-svelte/lib/FunnelIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import { roleColorOnDark, roleColorOnLight } from '#lib/ui/primitives/readable-color.js';

  import MemberIdentityRow from './MemberIdentityRow.svelte';
  import RoleTagIcon from './RoleTagIcon.svelte';
  import './sender-identity.css';
  import {
    DEFAULT_ALWAYS_LISTED_FROM,
    INITIAL_MEMBER_ROWS,
    MEMBERSHIP_FILTERS,
    MEMBERSHIP_FILTER_EMPTY_MESSAGES,
    MEMBERSHIP_FILTER_LABELS,
    MEMBER_ROWS_STEP,
    MEMBER_SORTS,
    MEMBER_SORT_LABELS,
    groupMembers,
    limitGroups,
    matchesFilter,
    memberName,
    membershipFor,
    type MembershipFilter,
  } from '#lib/rooms/member-listing.js';
  import { powerTag } from './power-tags';
  import type { PowerLevelTagMap } from '../settings/power-level-tags';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    roomId?: string;
    members: readonly MemberView[];
    loading: boolean;
    searchable?: boolean;
    powerTags?: PowerLevelTagMap | null;
    alwaysListedFrom?: number | null;
    loadMembership?: ((membership: MemberView['membership']) => Promise<MemberView[]>) | null;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
    count?: number;
  }

  let {
    roomId,
    members,
    loading,
    searchable = true,
    powerTags = {},
    alwaysListedFrom = null,
    loadMembership = null,
    onMemberProfile,
    count = $bindable(0),
  }: Props = $props();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  function connected(userId: string): boolean {
    if (!preferences.groupMembersByPresence) return true;
    const entry = presenceStore.peek(userId);
    return entry !== null && entry.presence !== 'offline';
  }

  let search = $state('');
  let filter = $state<MembershipFilter>('join');
  let fetched = $state.raw<MemberView[]>([]);
  let fetching = $state(false);
  let limit = $derived.by(() => {
    void members;
    void search;
    void filter;
    return INITIAL_MEMBER_ROWS;
  });

  let sort = $derived(preferences.memberSort);
  let joined = $derived(members.filter((member) => !member.service));
  let listed = $derived(filter === 'join' ? joined : fetched.filter((member) => !member.service));
  let matching = $derived(listed.filter((member) => matchesFilter(member, filter)));
  let searched = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return matching;
    return matching.filter((member) => memberName(member).toLocaleLowerCase().includes(query));
  });
  let groups = $derived(
    groupMembers(searched, sort, connected, alwaysListedFrom ?? DEFAULT_ALWAYS_LISTED_FROM)
  );
  let busy = $derived(powerTags === null || (filter === 'join' ? loading : fetching));
  let previewKey = $derived(
    JSON.stringify([
      sort,
      preferences.groupMembersByPresence,
      currentLocale(),
      preferences.developerTools && preferences.showTranslationStrings,
    ])
  );
  let preview = $derived(
    roomId && busy && filter === 'join' && !search.trim()
      ? core.memberPreviews.get(roomId, previewKey, alwaysListedFrom)
      : null
  );
  let shown = $derived(
    preview?.groups ??
      limitGroups(groups, limit).map((group) => ({ ...group, tag: groupTag(group.level) }))
  );
  let rowMembers = $derived(preview ? preview.groups.flatMap((group) => group.members) : listed);
  let hidden = $derived(preview ? 0 : Math.max(0, searched.length - limit));

  function groupTag(level: number | null) {
    return level === null
      ? { name: i18n.t('timeline.memberGroupOffline'), color: null, icon: null }
      : powerTag(level, i18n.t, powerTags ?? {});
  }

  $effect(() => {
    if (roomId && !busy && filter === 'join' && !search.trim()) {
      core.memberPreviews.set(roomId, {
        key: previewKey,
        threshold: alwaysListedFrom ?? DEFAULT_ALWAYS_LISTED_FROM,
        count: joined.length,
        groups: shown,
      });
    }
  });

  $effect(() => {
    void roomId;
    void members;
    const load = loadMembership;
    const membership = membershipFor(filter);
    if (filter === 'join' || !load) return;

    let current = true;
    fetching = true;
    void load(membership)
      .then((next) => {
        if (current) fetched = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] members unavailable', error);
        if (current) fetched = [];
      })
      .finally(() => {
        if (current) fetching = false;
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    count = preview?.count ?? joined.length;
  });
</script>

{#if searchable}
  <div class="controls">
    <div class="filters">
      {#if loadMembership}
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
  </div>
{/if}

{#if busy && !preview}
  <p class="status">{i18n.t('timeline.loadingMembers')}</p>
{:else if shown.length > 0}
  <div class="member-groups" aria-busy={busy} {@attach scrollHint}>
    {#each shown as group (group.key)}
      {@const tag = group.tag}
      <h3
        class={['group-label', { tinted: tag.color }]}
        style:--name-color-on-light={roleColorOnLight(tag.color)}
        style:--name-color-on-dark={roleColorOnDark(tag.color)}
      >
        {#if tag.icon}<RoleTagIcon icon={tag.icon} class="group-icon" />{/if}{tag.name}
      </h3>
      <ul>
        {#each group.members as member (member.user_id)}
          <li>
            <MemberIdentityRow
              class="member"
              userId={member.user_id}
              members={rowMembers}
              powerTag={tag}
              onProfile={onMemberProfile}
              showStatus
            />
          </li>
        {/each}
      </ul>
    {/each}
    {#if hidden > 0}
      <div
        class="load-sentinel"
        aria-hidden="true"
        {@attach (node) => {
          void limit;
          return whenVisible(() => (limit += MEMBER_ROWS_STEP))(node);
        }}
      ></div>
    {/if}
  </div>
{:else if search.trim() !== ''}
  <p class="status">{i18n.t('timeline.noMembersFound')}</p>
{:else}
  <p class="status">
    {i18n.t(MEMBERSHIP_FILTER_EMPTY_MESSAGES[filter])}
  </p>
{/if}

<style>
  .status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-300) var(--space-400);
  }

  .controls {
    background: var(--bg-container);
    display: grid;
    gap: var(--space-200);
    padding: var(--space-250);
    position: sticky;
    top: var(--header-height);
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

  .member-groups {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-100) var(--space-200) var(--space-200);
  }

  .group-label {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    line-height: var(--line-height-small);
    margin: 0;
    padding: var(--space-200) var(--space-200) var(--space-100);
  }

  .group-label.tinted {
    color: var(--ink);
  }

  :global(.group-icon) {
    margin-inline-end: var(--space-100);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .load-sentinel {
    height: 1px;
  }

  :global(.member-identity-row.member) {
    min-height: 3rem;
    padding: 0 var(--space-200);
  }

  :global(.member-identity-row.member .avatar-small) {
    --avatar-size: 2.125rem;
  }
</style>
