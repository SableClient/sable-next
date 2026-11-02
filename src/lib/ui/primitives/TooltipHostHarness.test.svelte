<script lang="ts">
  import Tooltip from './Tooltip.svelte';
  import TooltipProvider from './TooltipProvider.svelte';

  let { format, onclick }: { format: () => string; onclick?: () => void } = $props();
</script>

<TooltipProvider>
  <Tooltip label="First">One</Tooltip>
  <Tooltip>
    {#snippet content()}{format()}{/snippet}
    Two
  </Tooltip>
  <Tooltip label="Off" disabled>
    {#snippet trigger({ props })}<button {...props} type="button" {onclick}>Three</button>{/snippet}
  </Tooltip>
</TooltipProvider>
