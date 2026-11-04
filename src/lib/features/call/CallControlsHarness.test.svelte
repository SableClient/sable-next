<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import CallControls from './CallControls.svelte';

  let props: ComponentProps<typeof CallControls> = $props();
</script>

<TooltipProvider>
  <div class="dock">
    <CallControls {...props} />
  </div>
</TooltipProvider>

<style>
  .dock {
    container: call-dock / inline-size;
  }
</style>
