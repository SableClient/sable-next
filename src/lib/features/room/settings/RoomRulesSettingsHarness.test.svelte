<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import RoomRulesSettings from './RoomRulesSettings.svelte';

  let { settings, shown }: { settings: ComponentProps<typeof RoomRulesSettings>; shown: boolean } =
    $props();
  const settingsProps = $derived(settings);
  const isShown = $derived(shown);
</script>

{#if isShown}
  <svelte:boundary>
    <RoomRulesSettings {...settingsProps} />
    {#snippet pending()}{/snippet}
  </svelte:boundary>
{/if}
