<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Component } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  let { component: Navigator }: { component: Component<Record<string, unknown>> } = $props();
</script>

<TooltipProvider>
  <Dialog.Root open>
    <Navigator section={null} onSelect={() => {}} onBack={() => {}} onClose={() => {}}>
      {#snippet content()}{/snippet}
    </Navigator>
  </Dialog.Root>
</TooltipProvider>
