<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import type { BridgeView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  type Props = Omit<HTMLAttributes<HTMLSpanElement>, 'class'> & { bridge: BridgeView };

  let { bridge, ...rest }: Props = $props();
</script>

<span
  {...rest}
  class="bridge-badge"
  role="img"
  aria-label={i18n.t('nav.bridgedFrom', { network: bridge.network })}
>
  <Avatar src={bridge.avatar_url} name={bridge.network} size="tiny" />
</span>

<style>
  .bridge-badge {
    border-radius: 50%;
    bottom: calc(-1 * var(--space-050));
    box-shadow: 0 0 0 var(--border-width-400) var(--presence-ring, var(--bg-container));
    display: flex;
    left: calc(-1 * var(--space-050));
    position: absolute;
  }

  .bridge-badge :global(.avatar-tiny) {
    --avatar-size: var(--space-300);

    font-size: calc(var(--font-size-small) * 0.75);
  }
</style>
