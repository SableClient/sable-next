<script lang="ts">
  import type { Snippet } from 'svelte';

  import { AppLayout } from '#lib/ui/app-layout.svelte.js';

  import BottomSheet from './BottomSheet.svelte';
  import DialogFrame from './DialogFrame.svelte';

  interface Props {
    open?: boolean;
    label: string;
    closeLabel: string;
    expandable?: boolean;
    children: Snippet<[boolean]>;
  }

  let { open = $bindable(false), label, closeLabel, expandable, children }: Props = $props();

  const appLayout = new AppLayout();
  let desktop = $derived(appLayout.current);
</script>

{#if desktop}
  <DialogFrame bind:open variant="verification" {label}>
    {@render children(true)}
  </DialogFrame>
{:else}
  <BottomSheet bind:open {label} {closeLabel} {expandable}>
    {@render children(false)}
  </BottomSheet>
{/if}
