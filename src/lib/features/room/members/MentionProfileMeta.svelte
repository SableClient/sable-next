<script lang="ts">
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';

  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';

  import type { PowerLevelTag } from '../settings/power-level-tags';
  import RoleTagIcon from './RoleTagIcon.svelte';

  interface Props {
    loading?: boolean;
    lastSeenText?: string | null;
    localTime: { time: string; timezone: string } | null;
    roleTag: PowerLevelTag | null;
    elevated: boolean;
    animalText: string | null;
  }

  let {
    loading = false,
    lastSeenText = null,
    localTime,
    roleTag,
    elevated,
    animalText,
  }: Props = $props();
</script>

{#if loading}
  <span class="profile-meta-item"
    ><Skeleton style="height: var(--font-size-small); width: 5rem" /></span
  >
  <span class="profile-meta-item"
    ><Skeleton style="height: var(--font-size-small); width: 7rem" /></span
  >
{:else}
  {#if lastSeenText}
    <span class="profile-meta-item">{lastSeenText}</span>
  {/if}
  {#if localTime}
    <span class="profile-meta-item">
      <ClockIcon />
      {localTime.time}
      <span class="profile-meta-aside">({localTime.timezone})</span>
    </span>
  {/if}
  {#if roleTag}
    <span class={['profile-meta-item', { 'profile-meta-elevated': elevated }]}>
      <ShieldIcon />
      {#if roleTag.icon}<RoleTagIcon icon={roleTag.icon} class="profile-role-icon" />{/if}
      {roleTag.name}
    </span>
  {/if}
  {#if animalText}
    <span class="profile-meta-item"><HeartIcon />{animalText}</span>
  {/if}
{/if}

<style>
  .profile-meta-item {
    align-items: center;
    display: inline-flex;
    gap: var(--space-100);
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .profile-meta-item :global(.presence-dot) {
    margin: var(--space-100);
  }

  .profile-meta-elevated {
    color: var(--profile-ink, var(--bg-on-container));
    font-weight: var(--font-weight-medium);
  }

  .profile-meta-elevated :global(svg) {
    color: var(--profile-ink, var(--bg-on-container));
  }

  .profile-meta-aside {
    color: var(--profile-text-muted, var(--surface-var-on-container));
  }
</style>
