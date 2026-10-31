<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { onMount } from 'svelte';
  import { watchMatrixLinks } from '#lib/rooms/native-links.js';
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
  import AccountLocked from '#lib/features/sidebar/AccountLocked.svelte';
  import favicon from '#lib/assets/favicon.png';
  import { trackKeyboardInset } from '#lib/platform/keyboard.js';
  import { blockEdgeNavigation } from '#lib/platform/edge-navigation.js';
  import { systemDark } from '#lib/platform/system-theme.js';
  import { hostsServiceWorker, registerServiceWorker } from '#lib/platform/service-worker.js';
  import { notificationPermalink } from '#lib/features/notifications/notification-link.js';
  import { guardTouchClicks } from '#lib/ui/trailing-click.js';
  import { applyDesktopWindowSettings, titleBarKind } from '#lib/platform/window-decorations.js';
  import { electronBridge } from '#lib/platform/electron.js';
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
    applyFontFamily,
    applyFontFamilyMono,
    applyQuickCss,
    applyTheme,
    resolveTheme,
  } from '#lib/settings/theme.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import { ALERT_MODULES, provideAlertProviders } from '#lib/features/sidebar/alerts.js';
  import ServerLogin from './ServerLogin.svelte';
  import {
    bindServerNotificationIdentity,
    boundServerIdentity,
    isServerAuthenticationFailure,
    ServerSessionError,
  } from '#lib/notifications/room-names.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = createCoreClient();
  const serverMode = Boolean(import.meta.env.VITE_SABLE_SERVER_URL);
  let serverAuthEndpoint = $state('/_sable/auth');
  let serverAuthReady = $state(!serverMode);
  let serverAuthenticated = $state(!serverMode);
  let mounted = $state(false);
  provideCoreClient(core);
  const alertProviders = ALERT_MODULES.map((component) => component.priorityProvider());
  provideAlertProviders(alertProviders);
  let titlebar = $derived(titleBarKind(preferences.useCustomTitleBar));

  onMount(() => {
    mounted = true;
    void hydrateCatalogThemes().then(updateCatalogThemes);

    if (isTauri()) {
      document.documentElement.dataset.tauriOs = osType();
    }

    const identityChannel =
      serverMode && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('sable-server-identity')
        : null;
    if (identityChannel) {
      identityChannel.onmessage = (event: MessageEvent<unknown>) => {
        const current = boundServerIdentity();
        if (
          current &&
          typeof event.data === 'string' &&
          (event.data === 'logout' || event.data !== current)
        ) {
          core.stop();
          window.location.reload();
        }
      };
      const current = boundServerIdentity();
      if (current) identityChannel.postMessage(current);
    }
    const stopTrackingKeyboard = trackKeyboardInset();
    const stopGuardingClicks = guardTouchClicks();
    const stopBlockingEdgeNavigation = blockEdgeNavigation();
    void registerServiceWorker();
    void runtimeConfig().then((config) => {
      applyDeploymentDefaults(config.settingsDefaults);
    });
    const stopMatrixLinks = watchMatrixLinks((path) => {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- matrixLinkPath resolves the permalink route
      void goto(path);
    });
    if (serverMode) {
      const configured = import.meta.env.VITE_SABLE_SERVER_URL;
      serverAuthEndpoint = new URL(
        '/_sable/auth',
        new URL(configured ?? window.location.href, window.location.href)
      ).toString();
      void fetch(serverAuthEndpoint, { credentials: 'include' })
        .then((response) => {
          if (!response.ok && response.status !== 401 && response.status !== 403)
            throw new ServerSessionError(response.status);
          serverAuthenticated = response.ok;
        })
        .catch((error: unknown) => {
          console.error('[sable server] session check failed', error);
          core.restoreFailed = true;
          core.status = 'error';
        })
        .finally(() => {
          serverAuthReady = true;
        });
    }
    return () => {
      identityChannel?.close();
      stopTrackingKeyboard();
      stopGuardingClicks();
      stopBlockingEdgeNavigation();
      stopMatrixLinks();
      core.stop();
    };
  });

  $effect(() => {
    if (mounted && serverAuthReady && serverAuthenticated) {
      void (async () => {
        if (serverMode) {
          const previouslyBound = boundServerIdentity();
          await bindServerNotificationIdentity();
          // Stores read user-scoped storage at import; reload so they see this user.
          if (!previouslyBound) {
            window.location.reload();
            return;
          }
        }
        await core.start();
      })().catch((error: unknown) => {
        if (isServerAuthenticationFailure(error)) {
          serverAuthenticated = false;
          return;
        }
        console.error('[sable server] startup failed', error);
        core.restoreFailed = true;
        core.status = 'error';
      });
    }
  });

  $effect(() => {
    if (!hostsServiceWorker()) return;

    return on(navigator.serviceWorker, 'message', (event) => {
      if (page.route.id?.startsWith('/(app)')) return;
      const message = (event as MessageEvent).data as
        | { type?: string; roomId?: string; userId?: string; eventId?: string }
        | undefined;
      if (message?.type !== 'sable:open-room' || message.roomId === undefined) return;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- notificationPermalink() resolves the route itself
      void goto(notificationPermalink(message.roomId, message.eventId, message.userId));
    });
  });

  $effect(() => {
    document.documentElement.dataset.clientDecorations = titlebar ?? 'off';

    void applyDesktopWindowSettings({
      closeToTray: preferences.closeToTray,
      minimizeToTray: preferences.minimizeToTray,
      showSystemTrayIcon: preferences.showSystemTrayIcon,
      useCustomTitleBar: preferences.useCustomTitleBar,
      smoothScrolling: preferences.smoothScrolling,
    }).catch((error: unknown) => {
      console.debug('[sable window] the desktop window settings were not applied', error);
    });
  });

  $effect(() => {
    electronBridge()?.applySettings({
      hardwareAcceleration: preferences.hardwareAcceleration,
      hardwareVideoAcceleration: preferences.hardwareVideoAcceleration,
      smoothScrolling: preferences.smoothScrolling,
      webRtcIpPolicy: preferences.webRtcIpPolicy,
      updateChannel: preferences.updateChannel,
      launchAtLogin: preferences.launchAtLogin,
      startMinimized: preferences.startMinimized,
    });
  });

  $effect(() => {
    document.documentElement.style.setProperty('--font-scale', String(preferences.pageZoom));
    document.documentElement.style.setProperty('--text-scale', String(preferences.textScale));
    document.documentElement.dataset.highContrast = preferences.highContrast ? 'on' : 'off';
    document.documentElement.dataset.reducedMotion = shouldReduceMotion() ? 'on' : 'off';
    document.documentElement.dataset.twitterEmoji = preferences.twitterEmoji ? 'on' : 'off';
    document.documentElement.dataset.codeLigatures = preferences.codeLigatures ? 'on' : 'off';
    document.documentElement.dataset.blurMedia = preferences.blurMedia ? 'on' : 'off';
    document.documentElement.dataset.blurAvatars = preferences.blurAvatars ? 'on' : 'off';
    document.documentElement.dataset.blurEmotes = preferences.blurEmotes ? 'on' : 'off';
  });

  $effect(() => {
    const preview = themePreview.current;
    if (preview) {
      applyTheme(preview.kind, systemDark.current);
      applyCustomTheme(preview.css);
      return;
    }
    applyTheme(preferences.theme, systemDark.current);
    applyCustomTheme(activeCustomThemeCss(resolveTheme(preferences.theme, systemDark.current)));
  });

  $effect(() => {
    applyCustomTweaks(activeTweakCss());
  });

  $effect(() => {
    applyQuickCss(preferences.quickCss);
  });

  $effect(() => {
    applyFontFamily(preferences.fontFamily);
    applyFontFamilyMono(preferences.fontFamilyMono);
  });
</script>

<svelte:window ononline={() => void hydrateCatalogThemes()} />
<svelte:document
  onvisibilitychange={() => {
    if (document.visibilityState === 'visible') void updateCatalogThemes();
  }}
/>

<PageTitle title="Sable" />

<svelte:head>
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
    {:else if serverMode && !serverAuthReady}
      <main>Checking server session…</main>
    {:else if serverMode && !serverAuthenticated}
      <ServerLogin
        endpoint={serverAuthEndpoint}
        onAuthenticated={() => {
          window.location.reload();
        }}
      />
    {:else}
      {@render children()}
    {/if}
  </TooltipProvider>
</IconContext>
