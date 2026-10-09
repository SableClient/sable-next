<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import type { Snippet } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { type as osType } from '@tauri-apps/plugin-os';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import '../styles.css';
  import { createCoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import TitleBar from '#lib/ui/TitleBar.svelte';
  import SessionRestoreError from '#lib/ui/SessionRestoreError.svelte';
  import AccountLocked from '#lib/ui/AccountLocked.svelte';
  import favicon from '#lib/assets/favicon.png';
  import { trackKeyboardInset } from '#lib/platform/keyboard.js';
  import { trackInspectorShortcut } from '#lib/platform/devtools.js';
  import { suppressNativeContextMenu } from '#lib/platform/context-menu.js';
  import { blockEdgeNavigation } from '#lib/platform/edge-navigation.js';
  import { hostsServiceWorker, registerServiceWorker } from '#lib/platform/service-worker.js';
  import { notificationPermalink } from '#lib/features/notifications/notification-link.js';
  import { guardTouchClicks } from '#lib/ui/trailing-click.js';
  import {
    applyDesktopWindowSettings,
    titleBarKind,
    type TitleBarKind,
  } from '#lib/platform/window-decorations.js';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { applyDeploymentDefaults, preferences } from '#lib/settings/preferences.svelte.js';
  import {
    activeCustomThemeCss,
    activeTweakCss,
    hydrateCatalogThemes,
    updateCatalogThemes,
    themePreview,
  } from '#lib/settings/custom-themes.svelte.js';
  import {
    applyCustomTheme,
    applyCustomTweaks,
    applyQuickCss,
    applyTheme,
    resolveTheme,
  } from '#lib/settings/theme.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import { ALERT_MODULES, provideAlertProviders } from '#lib/features/sidebar/alerts.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = createCoreClient();
  provideCoreClient(core);
  const alertProviders = ALERT_MODULES.map((component) => component.priorityProvider());
  provideAlertProviders(alertProviders);
  let systemPrefersDark = $state(false);
  let titlebar = $state<TitleBarKind | null>(null);

  onMount(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemTheme = (): void => {
      systemPrefersDark = media.matches;
    };
    updateSystemTheme();
    void hydrateCatalogThemes().then(updateCatalogThemes);
    const stopListening = on(media, 'change', updateSystemTheme);
    const stopHydrating = on(window, 'online', () => void hydrateCatalogThemes());
    const stopUpdating = on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void updateCatalogThemes();
    });

    if (isTauri()) {
      document.documentElement.dataset.tauriOs = osType();
    }

    const stopTrackingKeyboard = trackKeyboardInset();
    const stopGuardingClicks = guardTouchClicks();
    const stopInspectorShortcut = trackInspectorShortcut();
    const stopSuppressingContextMenu = suppressNativeContextMenu();
    const stopBlockingEdgeNavigation = blockEdgeNavigation();
    void registerServiceWorker();
    void runtimeConfig().then((config) => {
      applyDeploymentDefaults(config.settingsDefaults);
    });
    void core.start();
    return () => {
      stopListening();
      stopHydrating();
      stopUpdating();
      stopTrackingKeyboard();
      stopGuardingClicks();
      stopInspectorShortcut();
      stopSuppressingContextMenu();
      stopBlockingEdgeNavigation();
      core.stop();
    };
  });

  $effect(() => {
    if (!hostsServiceWorker()) return;

    return on(navigator.serviceWorker, 'message', (event) => {
      if (page.route.id?.startsWith('/(app)')) return;
      const message = (event as MessageEvent).data as
        | { type?: string; roomId?: string; userId?: string; eventId?: string }
        | undefined;
      if (message?.type !== 'sable:open-room' || message.roomId === undefined) return;
      void goto(notificationPermalink(message.roomId, message.eventId, message.userId));
    });
  });

  $effect(() => {
    const kind = titleBarKind(preferences.useCustomTitleBar);
    titlebar = kind;
    document.documentElement.dataset.clientDecorations = kind === null ? 'off' : kind;

    void applyDesktopWindowSettings({
      closeToTray: preferences.closeToTray,
      showSystemTrayIcon: preferences.showSystemTrayIcon,
      useCustomTitleBar: preferences.useCustomTitleBar,
    }).catch((error: unknown) => {
      console.debug('[sable window] the desktop window settings were not applied', error);
    });
  });

  $effect(() => {
    document.documentElement.style.setProperty('--font-scale', String(preferences.pageZoom));
    document.documentElement.style.setProperty('--text-scale', String(preferences.textScale));
    document.documentElement.dataset.highContrast = preferences.highContrast ? 'on' : 'off';
    document.documentElement.dataset.reducedMotion = shouldReduceMotion() ? 'on' : 'off';
    document.documentElement.dataset.twitterEmoji = preferences.twitterEmoji ? 'on' : 'off';
    document.documentElement.dataset.blurMedia = preferences.blurMedia ? 'on' : 'off';
    document.documentElement.dataset.blurAvatars = preferences.blurAvatars ? 'on' : 'off';
    document.documentElement.dataset.blurEmotes = preferences.blurEmotes ? 'on' : 'off';
  });

  $effect(() => {
    const preview = themePreview.current;
    if (preview) {
      applyTheme(preview.kind, systemPrefersDark);
      applyCustomTheme(preview.css);
      return;
    }
    applyTheme(preferences.theme, systemPrefersDark);
    applyCustomTheme(activeCustomThemeCss(resolveTheme(preferences.theme, systemPrefersDark)));
  });

  $effect(() => {
    applyCustomTweaks(activeTweakCss());
  });

  $effect(() => {
    applyQuickCss(preferences.quickCss);
  });
</script>

<svelte:head>
  <title>Sable</title>
  <link rel="icon" href={favicon} />
</svelte:head>

<!-- Icons ride along with a labelled control, so `role="img"` would only add a
     nameless node to the tree. -->
<IconContext values={{ 'aria-hidden': true }}>
  {#if titlebar}
    <TitleBar kind={titlebar} />
  {/if}

  <TooltipProvider>
    {#if core.accountLocked}
      <AccountLocked />
    {:else if core.restoreFailed}
      <SessionRestoreError />
    {:else}
      {@render children()}
    {/if}
  </TooltipProvider>
</IconContext>
