<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import ActiveCallBar from './ActiveCallBar.svelte';

  let props: ComponentProps<typeof ActiveCallBar> = $props();
</script>

<TooltipProvider>
  <ActiveCallBar {...props} />
</TooltipProvider>
