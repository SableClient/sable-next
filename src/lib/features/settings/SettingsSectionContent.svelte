<script lang="ts">
  import { buildSettingsLink } from '#lib/features/room/settings-link.js';
  import {
    canonicalSection,
    findCategory,
    SETTINGS_DEVICES_SECTION,
  } from '#lib/settings/registry.js';
  import { provideSettingsAnchors } from '#lib/ui/primitives/settings-anchors.js';

  import SettingsCategoryView from './SettingsCategoryView.svelte';
  import { findSettingRow, scrollSettingRowIntoView } from './settings-focus.js';
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

  let highlighted = $state<string | null>(null);

  provideSettingsAnchors({
    link: (anchor) => buildSettingsLink(location.origin, pageId, anchor),
    highlighted: () => highlighted,
  });

  $effect(() => {
    const id = focus;
    highlighted = null;
    if (id === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void findSettingRow(id).then((target) => {
      if (cancelled || target === null) return;
      if (target.hasAttribute('data-settings-outline')) {
        scrollSettingRowIntoView(target.closest('section') ?? target, 'start');
        return;
      }

      scrollSettingRowIntoView(target);
      highlighted = id;
      timer = setTimeout(() => {
        if (!cancelled) highlighted = null;
      }, 3000);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  });
</script>

{#if standalone}
  <standalone.component />
{:else if category}
  <SettingsCategoryView {category} />
{/if}
