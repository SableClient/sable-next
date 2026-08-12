<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import { Dialog } from 'bits-ui';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '$lib/i18n';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  import { initials, senderColor } from './timeline-format';

  interface Props {
    members: readonly MemberView[];
    loading: boolean;
    modal?: boolean;
    onClose: () => void;
  }

  let { members, loading, modal = false, onClose }: Props = $props();
  let search = $state('');
  let filteredMembers = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return members;
    return members.filter((member) => memberName(member).toLocaleLowerCase().includes(query));
  });

  function memberName(member: MemberView): string {
    return member.display_name ?? member.user_id;
  }

  function powerLevel(member: MemberView): string | null {
    if (member.power_level >= 100) return $i18n.t('timeline.powerLevelAdmin');
    if (member.power_level >= 50) return $i18n.t('timeline.powerLevelModerator');
    return null;
  }
</script>

<aside class="members-drawer" aria-label={$i18n.t('timeline.members')}>
  <header>
    <div>
      {#if modal}
        <Dialog.Title class="title">{$i18n.t('timeline.members')}</Dialog.Title>
      {:else}
        <h2 class="title">{$i18n.t('timeline.members')}</h2>
      {/if}
      <p>{$i18n.t('timeline.memberCount', { count: members.length })}</p>
    </div>
    {#if modal}
      <Dialog.Close class="close" aria-label={$i18n.t('timeline.closeMembers')}
        ><XIcon /></Dialog.Close
      >
    {:else}
      <button
        class="close"
        type="button"
        aria-label={$i18n.t('timeline.closeMembers')}
        onclick={onClose}><XIcon /></button
      >
    {/if}
  </header>

  {#if loading}
    <p class="status">{$i18n.t('timeline.loadingMembers')}</p>
  {:else}
    <div class="search">
      <TextInput
        bind:value={search}
        class="member-search-input"
        placeholder={$i18n.t('timeline.searchMembers')}
        aria-label={$i18n.t('timeline.searchMembers')}
      />
    </div>
    {#if filteredMembers.length > 0}
      <ul>
        {#each filteredMembers as member (member.user_id)}
          {@const label = powerLevel(member)}
          <li>
            <Avatar
              size="small"
              initials={initials(memberName(member))}
              color={senderColor(member.user_id)}
            />
            <span class="name">{memberName(member)}</span>
            {#if label}<span class="power-level">{label}</span>{/if}
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

  header {
    align-items: center;
    border-bottom: 1px solid var(--sable-surface-var-container);
    display: flex;
    justify-content: space-between;
    min-height: 3.75rem;
    padding: 0.5rem 0.75rem 0.5rem 1rem;
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

  .close {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    justify-content: center;
    min-height: 2rem;
    padding: 0 0.5rem;
  }

  .close:hover,
  .close:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .close :global(svg) {
    height: 1.25rem;
    width: 1.25rem;
  }

  .status {
    margin: 0;
    padding: 0.75rem 1rem;
  }

  .search {
    padding: 0.75rem;
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
    align-items: center;
    display: flex;
    gap: 0.625rem;
    min-height: 3rem;
    padding: 0 0.5rem;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .power-level {
    background: var(--sable-sec-container);
    border-radius: 999px;
    color: var(--sable-sec-on-container);
    font-size: var(--font-size-small);
    margin-left: auto;
    padding: 0.125rem 0.5rem;
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
