<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import { Dialog } from 'bits-ui';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '$lib/i18n';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import StatusBadge from '$lib/ui/primitives/StatusBadge.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  import { initials, senderColor } from './timeline-format';

  interface Props {
    members: readonly MemberView[];
    loading: boolean;
    modal?: boolean;
    compact?: boolean;
    searchable?: boolean;
    title?: string;
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
    onClose,
    onMemberProfile,
  }: Props = $props();
  let search = $state('');
  let sortedMembers = $derived(
    [...members].toSorted(
      (left, right) =>
        right.power_level - left.power_level ||
        memberName(left).localeCompare(memberName(right), undefined, { sensitivity: 'base' })
    )
  );
  let filteredMembers = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sortedMembers;
    return sortedMembers.filter((member) => memberName(member).toLocaleLowerCase().includes(query));
  });

  function memberName(member: MemberView): string {
    return member.display_name ?? member.user_id;
  }

  function powerLevel(member: MemberView): string | null {
    if (member.power_level >= 100) return $i18n.t('timeline.powerLevelAdmin');
    if (member.power_level >= 50) return $i18n.t('timeline.powerLevelModerator');
    return null;
  }

  function openMemberProfile(
    member: MemberView,
    event: MouseEvent & { currentTarget: HTMLButtonElement }
  ): void {
    onMemberProfile(member.user_id, event.currentTarget);
  }
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

  {#if loading}
    <p class="status">{$i18n.t('timeline.loadingMembers')}</p>
  {:else}
    {#if searchable}
      <div class="search">
        <TextInput
          bind:value={search}
          class="member-search-input"
          placeholder={$i18n.t('timeline.searchMembers')}
          aria-label={$i18n.t('timeline.searchMembers')}
        />
      </div>
    {/if}
    {#if filteredMembers.length > 0}
      <ul>
        {#each filteredMembers as member (member.user_id)}
          {@const label = powerLevel(member)}
          <li>
            <button
              class="member"
              type="button"
              aria-label={$i18n.t('timeline.senderProfile', { name: memberName(member) })}
              onclick={(event) => {
                openMemberProfile(member, event);
              }}
            >
              <Avatar
                size="small"
                src={member.avatar_url}
                initials={initials(memberName(member))}
                color={senderColor(member.user_id)}
              />
              <span class="name">{memberName(member)}</span>
              {#if label}
                <span class="power-level"><StatusBadge {label} variant="secondary" /></span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">{$i18n.t('timeline.noMembersFound')}</p>
    {/if}
  {/if}
</aside>

<style>
  .members-drawer {
    background: var(--sable-bg-container);
    box-shadow: -0.5rem 0 1rem var(--sable-shadow);
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
    border-bottom: 1px solid var(--sable-surface-var-container);
    display: flex;
    justify-content: space-between;
    min-height: 3.75rem;
    padding: 0.5rem 0.75rem 0.5rem 1rem;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .title,
  header p {
    margin: 0;
  }

  .title {
    font-size: var(--font-size-large);
  }

  header p,
  .status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .status {
    margin: 0;
    padding: 0.75rem 1rem;
  }

  .search {
    background: var(--sable-bg-container);
    padding: 0.75rem;
    position: sticky;
    top: 3.75rem;
    z-index: 1;
  }

  :global(.member-search-input) {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    min-height: 2.5rem;
    padding: 0 0.75rem;
    width: 100%;
  }

  ul {
    flex: 1;
    list-style: none;
    margin: 0;
    min-height: 0;
    overflow: auto;
    padding: 0.25rem 0.5rem 0.5rem;
  }

  li {
    min-height: 3rem;
  }

  .member {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: 0.625rem;
    min-height: 3rem;
    padding: 0 0.5rem;
    text-align: left;
    width: 100%;
  }

  .member:hover {
    background: var(--sable-surface-container);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .power-level {
    margin-left: auto;
  }

  @media (width >= 48rem) {
    .members-drawer {
      border-left: 1px solid var(--sable-surface-var-container);
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
