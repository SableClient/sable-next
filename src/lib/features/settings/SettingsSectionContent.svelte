<script lang="ts">
  import { findCategory, SETTINGS_ACCOUNT_SECTION } from '$lib/settings/registry';
  import AccountSettings from './AccountSettings.svelte';
  import DevicesSettings from './DevicesSettings.svelte';
  import SettingsCategoryView from './SettingsCategoryView.svelte';

  interface Props {
    section: string | null;
  }

  let { section }: Props = $props();
  let category = $derived(findCategory(section ?? undefined));
</script>

{#if section === SETTINGS_ACCOUNT_SECTION}
  <AccountSettings />
{:else if category}
  <SettingsCategoryView {category} />
{:else}
  <DevicesSettings />
{/if}
