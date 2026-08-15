<script lang="ts">
  import { findCategory } from '$lib/settings/registry';
  import DevicesSettings from './DevicesSettings.svelte';
  import SettingsCategoryView from './SettingsCategoryView.svelte';

  interface Props {
    section: string | null;
  }

  let { section }: Props = $props();
  let category = $derived(findCategory(section ?? undefined));
</script>

{#if category}
  <SettingsCategoryView {category} />
{:else}
  <DevicesSettings />
{/if}
