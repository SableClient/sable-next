<script lang="ts">
  import type { Component } from 'svelte';

  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  interface Props {
    component: Component<never>;
    props: Record<string, unknown>;
  }

  let { component, props }: Props = $props();
  let Inner = $derived(component as Component<Record<string, unknown>>);
</script>

<TooltipProvider>
  <Inner {...props} />
</TooltipProvider>
