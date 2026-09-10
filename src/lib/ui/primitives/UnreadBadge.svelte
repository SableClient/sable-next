<script lang="ts">
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';

  import { preferences } from '#lib/settings/preferences.svelte.js';

  import { formatUnreadCount, resolveUnreadBadge, type UnreadBadgeCounts } from './unread-badge.js';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'children'> & {
    counts: UnreadBadgeCounts | undefined;
    dm?: boolean;
    class?: ClassValue;
  };

  let { counts, dm = false, class: className = '', ...rest }: Props = $props();

  let badge = $derived(resolveUnreadBadge(counts, preferences, dm));
</script>

{#if badge}
  <span
    {...rest}
    class={[
      'unread-badge',
      `unread-badge-${badge.mode}`,
      badge.highlight && 'unread-badge-highlight',
      className,
    ]}>{badge.mode === 'count' ? formatUnreadCount(badge.count) : ''}</span
  >
{/if}

<style>
  :global(.unread-badge) {
    background: var(--sec-main);
    color: var(--sec-on-main);
    flex: none;
    pointer-events: none;
  }

  :global(.unread-badge-highlight) {
    background: var(--success-main);
    color: var(--success-on-main);
  }

  :global(.unread-badge-dot) {
    border-radius: var(--radii-round);
    display: inline-block;
    height: 0.5rem;
    width: 0.5rem;
  }

  :global(.unread-badge-count) {
    align-items: center;
    border-radius: var(--radii-pill);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    justify-content: center;
    line-height: var(--line-height-small);
    min-width: 1rem;
    padding: 0 var(--space-100);
  }
</style>
