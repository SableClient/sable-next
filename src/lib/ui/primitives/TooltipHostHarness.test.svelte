<script lang="ts">
  import Tooltip from './Tooltip.svelte';
  import TooltipHost, { provideTooltipHost } from './TooltipHost.svelte';
  import TooltipProvider from './TooltipProvider.svelte';

  let { format }: { format: () => string } = $props();

  const tether = provideTooltipHost();
</script>

<TooltipProvider>
  <Tooltip label="First">One</Tooltip>
  <Tooltip>
    {#snippet content()}{format()}{/snippet}
    Two
  </Tooltip>
  <TooltipHost {tether} />
</TooltipProvider>
