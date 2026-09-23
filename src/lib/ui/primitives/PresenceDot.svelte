<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import type { PresenceView } from '#src/generated/protocol';

  interface Props {
    presence: PresenceView;
    label: string;
    size?: 'small' | 'medium';
    class?: ClassValue;
  }

  let { presence, label, size = 'small', class: className = '' }: Props = $props();
</script>

<span
  class={['presence-dot', size === 'medium' && 'presence-dot-medium', className]}
  data-presence={presence}
  role="img"
  aria-label={label}
></span>

<style>
  .presence-dot {
    background: var(--sec-main);
    border-radius: var(--radii-round);
    box-shadow: 0 0 0 var(--border-width-500) var(--bg-container);
    display: inline-block;
    flex: none;
    height: var(--space-150);
    width: var(--space-150);
  }

  .presence-dot-medium {
    height: var(--space-200);
    width: var(--space-200);
  }

  .presence-dot[data-presence='online'] {
    background: var(--success-main);
  }

  .presence-dot[data-presence='unavailable'] {
    background: var(--warn-main);
  }
</style>
