<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import CallView from './CallView.svelte';

  let props: ComponentProps<typeof CallView> = $props();
</script>

<TooltipProvider>
  <CallView {...props} />
</TooltipProvider>
