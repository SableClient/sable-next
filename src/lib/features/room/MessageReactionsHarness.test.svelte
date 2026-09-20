<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import MessageReactions from './MessageReactions.svelte';

  let props: ComponentProps<typeof MessageReactions> = $props();
</script>

<TooltipProvider>
  <MessageReactions {...props} />
</TooltipProvider>
