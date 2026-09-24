<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import type { SettingsCategory } from '#lib/settings/registry.js';
  import SettingsCategorySections from './SettingsCategorySections.svelte';

  interface Props {
    category: SettingsCategory;
  }

  let { category }: Props = $props();
</script>

<AppPageShell
  title={$i18n.t(category.name)}
  description={category.description ? $i18n.t(category.description) : undefined}
  density="compact"
  class="settings-category"
>
  <SettingsCategorySections {category} />
</AppPageShell>

<style>
  :global(.settings-scroll .app-page-shell.settings-category) {
    max-width: none;
    overflow: visible;
  }
</style>
