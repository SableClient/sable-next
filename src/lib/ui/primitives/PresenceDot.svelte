<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import type { PresenceView } from '#src/generated/PresenceView';

  interface Props {
    presence: PresenceView;
    label: string;
    size?: 'small' | 'medium';
    class?: ClassValue;
  }

  let { presence, label, size = 'small', class: className = '' }: Props = $props();
</script>

<span
  class={['sable-presence-dot', size === 'medium' && 'sable-presence-dot-medium', className]}
  data-presence={presence}
  role="img"
  aria-label={label}
></span>

<style>
  .sable-presence-dot {
    background: var(--sable-sec-main);
    border-radius: var(--radii-round);
    box-shadow: 0 0 0 var(--border-width-500) var(--sable-bg-container);
    display: inline-block;
    flex: none;
    height: var(--space-150);
    width: var(--space-150);
  }

  .sable-presence-dot-medium {
    height: var(--space-200);
    width: var(--space-200);
  }

  .sable-presence-dot[data-presence='online'] {
    background: var(--sable-success-main);
  }

  .sable-presence-dot[data-presence='unavailable'] {
    background: var(--sable-warn-main);
  }
</style>
