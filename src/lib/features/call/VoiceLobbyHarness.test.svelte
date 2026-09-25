<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import VoiceLobby from './VoiceLobby.svelte';

  let props: ComponentProps<typeof VoiceLobby> = $props();
</script>

<TooltipProvider>
  <VoiceLobby {...props} />
</TooltipProvider>
