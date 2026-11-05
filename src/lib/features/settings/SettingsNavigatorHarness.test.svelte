<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Component } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  let {
    component: Navigator,
    section = null,
    outlineLabel,
  }: {
    component: Component<Record<string, unknown>>;
    section?: string | null;
    outlineLabel?: string;
  } = $props();
</script>

<TooltipProvider>
  <Dialog.Root open>
    <Navigator {section} onSelect={() => {}} onBack={() => {}} onClose={() => {}}>
      {#snippet content()}
        {#if outlineLabel}
          <section><h2 id="test-heading" data-settings-outline>{outlineLabel}</h2></section>
        {/if}
      {/snippet}
    </Navigator>
  </Dialog.Root>
</TooltipProvider>
