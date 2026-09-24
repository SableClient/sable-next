<script lang="ts">
  import { buildSettingsLink } from '#lib/features/room/settings-link.js';
  import {
    canonicalSection,
    findCategory,
    SETTINGS_DEVICES_SECTION,
  } from '#lib/settings/registry.js';
  import { provideSettingsAnchorLink } from '#lib/ui/primitives/settings-anchor-link.js';

  import SettingsCategoryView from './SettingsCategoryView.svelte';
  import {
    findSettingRow,
    provideSettingsFocus,
    scrollSettingRowIntoView,
  } from './settings-focus.js';
  import { findStandaloneSection } from './sections.js';

  interface Props {
    section: string | null;
    focus?: string | null;
  }

  let { section, focus = null }: Props = $props();
  let page = $derived(section === null ? null : canonicalSection(section));
  let category = $derived(findCategory(page ?? undefined));
  let standalone = $derived(
    findStandaloneSection(page) ??
      (category ? undefined : findStandaloneSection(SETTINGS_DEVICES_SECTION))
  );
  let pageId = $derived(standalone?.id ?? category?.id ?? SETTINGS_DEVICES_SECTION);

  provideSettingsFocus(() => focus);
  provideSettingsAnchorLink((anchor) => buildSettingsLink(location.origin, pageId, anchor));

  $effect(() => {
    const id = focus;
    if (id === null) return;

    let cancelled = false;
    void findSettingRow(id).then((heading) => {
      if (cancelled || !heading?.hasAttribute('data-settings-outline')) return;
      scrollSettingRowIntoView(heading.closest('section') ?? heading, 'start');
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if standalone}
  <standalone.component />
{:else if category}
  <SettingsCategoryView {category} />
{/if}
