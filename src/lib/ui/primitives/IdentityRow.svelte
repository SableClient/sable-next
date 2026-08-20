<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import Avatar from './Avatar.svelte';

  type Props = {
    displayName: string;
    avatarUrl?: string | null;
    initials?: string;
    color?: string;
    size?: 'small' | 'medium' | 'large';
    shape?: 'person' | 'room';
    class?: ClassValue;
    ariaLabel?: string;
    meta?: Snippet;
    children?: Snippet;
    onclick?: (event: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
  };

  let {
    displayName,
    avatarUrl = null,
    initials = displayName.slice(0, 1),
    color,
    size = 'small',
    shape = 'person',
    class: className = '',
    ariaLabel,
    meta,
    children,
    onclick,
  }: Props = $props();
</script>

{#if onclick}
  <button
    class={['identity-row', 'identity-row-button', className]}
    type="button"
    aria-label={ariaLabel}
    {onclick}
  >
    <Avatar src={avatarUrl} {initials} {color} {size} {shape} />
    <span class="identity-row-name name">{displayName}</span>
    {#if meta}<span class="identity-row-meta">{@render meta()}</span>{/if}
    {@render children?.()}
  </button>
{:else}
  <div class={['identity-row', className]}>
    <Avatar src={avatarUrl} {initials} {color} {size} {shape} />
    <span class="identity-row-name name">{displayName}</span>
    {#if meta}<span class="identity-row-meta">{@render meta()}</span>{/if}
    {@render children?.()}
  </div>
{/if}

<style>
  :global(.identity-row) {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--space-1);
    min-width: 0;
  }

  :global(.identity-row-button) {
    background: transparent;
    border: 0;
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-align: left;
    width: 100%;
  }

  :global(.identity-row-button:hover) {
    background: var(--sable-surface-container);
  }

  :global(.identity-row-button:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .identity-row-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .identity-row-meta {
    align-items: center;
    display: inline-flex;
    gap: var(--space-1);
    margin-left: auto;
  }
</style>
