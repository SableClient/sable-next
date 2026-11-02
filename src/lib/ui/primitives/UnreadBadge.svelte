<script lang="ts">
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';

  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';

  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';

  import {
    formatUnreadCount,
    hideQuietDot,
    resolveUnreadBadge,
    type UnreadBadgeCounts,
  } from './unread-badge.js';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'children'> & {
    counts: UnreadBadgeCounts | undefined;
    dm?: boolean;
    label?: string;
    class?: ClassValue;
  };

  let { counts, dm = false, label, class: className = '', ...rest }: Props = $props();

  let badge = $derived(
    hideQuietDot(resolveUnreadBadge(counts, preferences, dm), preferences.showUnreadDots)
  );
</script>

{#if badge}
  <span
    {...rest}
    in:scale={{ start: 0.6, duration: motionMs(MOTION_MS.quick), easing: cubicOut }}
    class={[
      'unread-badge',
      `unread-badge-${badge.mode}`,
      badge.highlight && 'unread-badge-highlight',
      className,
    ]}
    >{#if label}<span aria-hidden="true"
        >{badge.mode === 'count'
          ? formatUnreadCount(badge.count, preferences.showEasterEggs)
          : ''}</span
      ><span class="screen-reader-only">{label}</span>{:else}{badge.mode === 'count'
        ? formatUnreadCount(badge.count, preferences.showEasterEggs)
        : ''}{/if}</span
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
    box-sizing: border-box;
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    height: var(--size-x50);
    justify-content: center;
    line-height: var(--size-x50);
    min-width: var(--size-x50);
    padding: 0 var(--space-100);
  }
</style>
