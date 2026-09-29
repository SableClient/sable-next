<script lang="ts">
  import Tooltip from './Tooltip.svelte';
  import TooltipProvider from './TooltipProvider.svelte';
</script>

<TooltipProvider>
  <Tooltip label="Test tooltip" open>Help</Tooltip>
</TooltipProvider>
