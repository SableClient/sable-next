<script module lang="ts">
  import { hasContext, setContext } from 'svelte';

  const PROVIDED = Symbol('tooltip-provider');

  export function tooltipProvided(): boolean {
    return hasContext(PROVIDED);
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Tooltip as BitsTooltip } from 'bits-ui';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  setContext(PROVIDED, true);
</script>

<BitsTooltip.Provider
  delayDuration={400}
  skipDelayDuration={80}
  ignoreNonKeyboardFocus
  disableHoverableContent
>
  {@render children()}
</BitsTooltip.Provider>
