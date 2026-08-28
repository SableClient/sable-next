<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import type { Snippet } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { type as osType } from '@tauri-apps/plugin-os';
  import { Tooltip } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import '../styles.css';
  import { createCoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import BannerDock from '#lib/ui/BannerDock.svelte';
  import CoreHealthBanner from '#lib/ui/CoreHealthBanner.svelte';
  import DesktopUpdateBanner from '#lib/ui/DesktopUpdateBanner.svelte';
  import WebUpdateBanner from '#lib/ui/WebUpdateBanner.svelte';
  import TelemetryConsentBanner from '#lib/ui/TelemetryConsentBanner.svelte';
  import UnverifiedDeviceBanner from '#lib/ui/UnverifiedDeviceBanner.svelte';
  import favicon from '#lib/assets/favicon.png';
  import { trackKeyboardInset } from '#lib/platform/keyboard.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { activeCustomThemeCss } from '#lib/settings/custom-themes.svelte.js';
  import { applyCustomTheme, applyTheme, resolveTheme } from '#lib/settings/theme.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = createCoreClient();
  provideCoreClient(core);
  let systemPrefersDark = $state(false);

  onMount(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = (): void => {
      systemPrefersDark = media.matches;
    };
    updateSystemTheme();
    const stopListening = on(media, 'change', updateSystemTheme);

    if (isTauri()) {
      document.documentElement.dataset.tauriOs = osType();
    }
    const stopTrackingKeyboard = trackKeyboardInset();
    void core.start();
    return () => {
      stopListening();
      stopTrackingKeyboard();
      core.stop();
    };
  });

  $effect(() => {
    applyTheme(preferences.theme, systemPrefersDark);
    applyCustomTheme(activeCustomThemeCss(resolveTheme(preferences.theme, systemPrefersDark)));
  });
</script>

<svelte:head>
  <title>Sable</title>
  <link rel="icon" href={favicon} />
</svelte:head>

<!-- Icons ride along with a labelled control, so `role="img"` would only add a
     nameless node to the tree. -->
<IconContext values={{ 'aria-hidden': true }}>
  <CoreHealthBanner />
  <BannerDock>
    <TelemetryConsentBanner />
    <UnverifiedDeviceBanner />
    <DesktopUpdateBanner />
    <WebUpdateBanner />
  </BannerDock>

  <Tooltip.Provider delayDuration={400} skipDelayDuration={100}>
    {@render children()}
  </Tooltip.Provider>
</IconContext>
