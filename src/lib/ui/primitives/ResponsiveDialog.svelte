<script lang="ts">
  import type { Snippet } from 'svelte';

  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';

  import BottomSheet from './BottomSheet.svelte';
  import DialogFrame from './DialogFrame.svelte';

  interface Props {
    open?: boolean;
    label: string;
    closeLabel: string;
    children: Snippet<[boolean]>;
  }

  let { open = $bindable(false), label, closeLabel, children }: Props = $props();

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
</script>

{#if desktop}
  <DialogFrame bind:open variant="verification" {label}>
    {@render children(true)}
  </DialogFrame>
{:else}
  <BottomSheet bind:open {label} {closeLabel}>
    {@render children(false)}
  </BottomSheet>
{/if}
