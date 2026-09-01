<script lang="ts">
  import { findCategory, SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';

  import SettingsCategoryView from './SettingsCategoryView.svelte';
  import { findStandaloneSection } from './sections.js';

  interface Props {
    section: string | null;
    focus?: string | null;
  }

  let { section, focus = null }: Props = $props();
  let category = $derived(findCategory(section ?? undefined));
  let standalone = $derived(
    findStandaloneSection(section) ??
      (category ? undefined : findStandaloneSection(SETTINGS_DEVICES_SECTION))
  );
</script>

{#if standalone}
  <standalone.component />
{:else if category}
  <SettingsCategoryView {category} {focus} />
{/if}
