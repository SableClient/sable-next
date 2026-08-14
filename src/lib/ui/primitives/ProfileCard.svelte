<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import Avatar from './Avatar.svelte';

  interface Props {
    displayName: string;
    userId: string;
    avatarUrl?: string | null;
    color: string;
    class?: ClassValue;
    children?: Snippet;
  }

  let {
    displayName,
    userId,
    avatarUrl = null,
    color,
    class: className = '',
    children,
  }: Props = $props();
  let initials = $derived(displayName.slice(0, 1).toUpperCase() || '?');
</script>

<section class={['sable-profile-card', className]}>
  <div class="profile-card-cover" style:background={color}></div>
  <Avatar
    class="profile-card-avatar"
    size="large"
    src={avatarUrl}
    {initials}
    {color}
    alt={displayName}
  />
  <div class="profile-card-identity">
    <p class="profile-card-name">{displayName}</p>
    <p class="profile-card-user-id">{userId}</p>
    {#if children}
      <div class="profile-card-bio">{@render children()}</div>
    {/if}
  </div>
</section>

<style>
  .sable-profile-card {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    overflow: hidden;
    position: relative;
  }

  .profile-card-cover {
    height: 6.5rem;
  }

  :global(.sable-avatar.profile-card-avatar) {
    border: 0.25rem solid var(--sable-bg-container);
    left: var(--space-3);
    position: absolute;
    top: 4.5rem;
  }

  .profile-card-identity {
    padding: 3rem var(--space-3) var(--space-3);
  }

  .profile-card-name,
  .profile-card-user-id {
    margin: 0;
  }

  .profile-card-name {
    font-size: var(--font-size-xlarge);
    font-weight: var(--font-weight-bold);
  }

  .profile-card-user-id {
    color: var(--sable-surface-var-on-container);
    margin-top: 0.125rem;
    overflow-wrap: anywhere;
  }

  .profile-card-bio {
    border-top: 1px solid var(--sable-surface-container-line);
    line-height: var(--line-height-body);
    margin: var(--space-3) 0 0;
    padding-top: var(--space-3);
    white-space: pre-wrap;
  }

  .profile-card-bio :global(.formatted-body) {
    white-space: normal;
  }
</style>
