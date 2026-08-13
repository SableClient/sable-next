<script lang="ts">
  import { page } from '$app/state';
  import DevicesSettings from '$lib/features/settings/DevicesSettings.svelte';
  import RoutePlaceholder from '$lib/ui/RoutePlaceholder.svelte';
</script>

{#if page.params.section === 'devices'}
  <DevicesSettings />
{:else}
  <RoutePlaceholder titleKey="settings.general" />
{/if}
