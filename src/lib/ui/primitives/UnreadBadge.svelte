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
      'sable-unread-badge',
      `sable-unread-badge-${badge.mode}`,
      badge.highlight && 'sable-unread-badge-highlight',
      className,
    ]}>{badge.mode === 'count' ? formatUnreadCount(badge.count) : ''}</span
  >
{/if}

<style>
  :global(.sable-unread-badge) {
    background: var(--sable-sec-main);
    color: var(--sable-sec-on-main);
    flex: none;
    pointer-events: none;
  }

  :global(.sable-unread-badge-highlight) {
    background: var(--sable-success-main);
    color: var(--sable-success-on-main);
  }

  :global(.sable-unread-badge-dot) {
    border-radius: var(--radii-round);
    display: inline-block;
    height: 0.5rem;
    width: 0.5rem;
  }

  :global(.sable-unread-badge-count) {
    align-items: center;
    border-radius: var(--radii-pill);
    display: inline-flex;
    font-size: var(--font-size-l400);
    font-weight: var(--font-weight-bold);
    justify-content: center;
    line-height: var(--line-height-l400);
    min-width: 1rem;
    padding: 0 var(--space-100);
  }
</style>
