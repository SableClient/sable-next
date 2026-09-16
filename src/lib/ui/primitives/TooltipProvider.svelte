<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Tooltip as BitsTooltip } from 'bits-ui';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<BitsTooltip.Provider delayDuration={400} skipDelayDuration={80}>
  {@render children()}
</BitsTooltip.Provider>
