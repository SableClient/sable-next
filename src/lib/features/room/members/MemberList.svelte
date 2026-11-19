<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import { roleColorOnDark, roleColorOnLight } from '#lib/ui/primitives/readable-color.js';

  import MemberIdentityRow from './MemberIdentityRow.svelte';
  import RoleTagIcon from './RoleTagIcon.svelte';
  import './sender-identity.css';
  import {
    DEFAULT_ALWAYS_LISTED_FROM,
    INITIAL_MEMBER_ROWS,
    MEMBERSHIP_FILTER_EMPTY_MESSAGES,
    MEMBER_ROWS_STEP,
    groupMembers,
    limitGroups,
    matchesFilter,
    memberName,
    membershipFor,
    type MembershipFilter,
  } from '#lib/rooms/member-listing.js';
  import { powerTag } from './power-tags';
  import type { PowerLevelTagMap } from '../settings/power-level-tags';

  interface Props {
    roomId?: string;
    members: readonly MemberView[];
    loading: boolean;
    search: string;
    filter: MembershipFilter;
    powerTags?: PowerLevelTagMap | null;
    alwaysListedFrom?: number | null;
    loadMembership?: ((membership: MemberView['membership']) => Promise<MemberView[]>) | null;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
    count?: number;
    resultCount?: number | null;
  }

  let {
    roomId,
    members,
    loading,
    search,
    filter,
    powerTags = {},
    alwaysListedFrom = null,
    loadMembership = null,
    onMemberProfile,
    count = $bindable(0),
    resultCount = $bindable(null),
  }: Props = $props();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();

  function connected(userId: string): boolean {
    if (!preferences.groupMembersByPresence) return true;
    const entry = presenceStore.peek(userId);
    return entry !== null && entry.presence !== 'offline';
  }

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
    resultCount = busy ? null : searched.length;
  });
</script>

{#if busy && !preview}
  <p class="status">{i18n.t('timeline.loadingMembers')}</p>
{:else if shown.length > 0}
  <div class="member-groups" aria-busy={busy}>
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

  .member-groups {
    padding: 0 var(--space-200) var(--space-200);
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
