<script module lang="ts">
  import { createContext, type Snippet } from 'svelte';
  import { Tooltip as BitsTooltip } from 'bits-ui';

  export interface TooltipPayload {
    label: string;
    multiline: boolean;
    side: 'top' | 'right' | 'bottom' | 'left';
    align: 'start' | 'center' | 'end';
    content?: Snippet;
  }

  export type TooltipTether = BitsTooltip.Tether<TooltipPayload>;

  const [getHost, setHost, hasHost] = createContext<TooltipTether | null>();

  export function tooltipHost(): TooltipTether | null {
    return hasHost() ? getHost() : null;
  }

  export function provideTooltipHost(): TooltipTether {
    const tether = BitsTooltip.createTether<TooltipPayload>();
    setHost(tether);
    return tether;
  }
</script>

<script lang="ts">
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';

  import './tooltip.css';

  interface Props {
    tether: TooltipTether;
  }

  let { tether }: Props = $props();

  // Tooltips inside the shared content would otherwise retarget the tooltip that shows them.
  setHost(null);
</script>

<BitsTooltip.Root {tether}>
  {#snippet children({ payload })}
    <BitsTooltip.Portal>
      <BitsTooltip.Content
        class={payload?.multiline ? 'tooltip tooltip-multiline' : 'tooltip'}
        side={payload?.side ?? 'top'}
        align={payload?.align ?? 'center'}
        sideOffset={8}
        collisionPadding={collisionPadding()}
      >
        {#if payload?.content}{@render payload.content()}{:else}{payload?.label}{/if}
      </BitsTooltip.Content>
    </BitsTooltip.Portal>
  {/snippet}
</BitsTooltip.Root>
