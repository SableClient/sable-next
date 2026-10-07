<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import type { PresenceView } from '#src/generated/protocol';

  interface Props {
    presence: PresenceView;
    label: string;
    size?: 'small' | 'medium' | 'large';
    class?: ClassValue;
  }

  let { presence, label, size = 'small', class: className = '' }: Props = $props();
</script>

<span
  class={[
    'presence-dot',
    size === 'medium' && 'presence-dot-medium',
    size === 'large' && 'presence-dot-large',
    className,
  ]}
  data-presence={presence}
  role="img"
  aria-label={label}
>
  <svg viewBox="0 0 10 10" aria-hidden="true">
    {#if presence === 'unavailable'}
      <path d="M5 0A5 5 0 1 0 10 5A4 4 0 0 1 5 0Z" />
    {:else if presence === 'offline'}
      <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="2" />
    {:else}
      <circle cx="5" cy="5" r="5" />
    {/if}
  </svg>
</span>

<style>
  .presence-dot {
    color: var(--sec-main);
    display: inline-block;
    flex: none;
    height: var(--space-150);
    isolation: isolate;
    width: var(--space-150);
  }

  :where(.presence-dot) {
    position: relative;
  }

  .presence-dot::before {
    background: radial-gradient(
      circle closest-side,
      var(--presence-ring, var(--bg-container)) 100%,
      transparent 0
    );
    content: '';
    inset: calc(-1 * var(--border-width-500));
    position: absolute;
    z-index: -1;
  }

  .presence-dot svg {
    display: block;
    fill: currentcolor;
    height: 100%;
    width: 100%;
  }

  .presence-dot-medium {
    height: var(--space-200);
    width: var(--space-200);
  }

  .presence-dot-large {
    height: var(--space-250);
    width: var(--space-250);
  }

  .presence-dot[data-presence='online'] {
    color: var(--success-main);
  }

  .presence-dot[data-presence='unavailable'] {
    color: var(--warn-main);
  }
</style>
