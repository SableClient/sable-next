<script lang="ts">
  import type { Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { page } from '$app/state';
  import AppShell from '$lib/ui/AppShell.svelte';
  import SettingsPanel from '$lib/features/settings/SettingsPanel.svelte';
  import { followSettingsLink } from '$lib/features/settings/settings-navigation';
  import { BREAKPOINTS } from '$lib/ui/breakpoints';
  import { createMediaQuery } from '$lib/ui/media-query.svelte';
  import { useCoreClient } from '$lib/core/context';
  import { provideRoomList, RoomList, roomPathParamFromId } from '$lib/rooms/room-list.svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { i18n } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Spinner from '$lib/ui/primitives/Spinner.svelte';
  import { preferences } from '$lib/settings/preferences.svelte';
  import { registerNativePush } from '$lib/features/notifications/native-push';
  import { pushOverride } from '$lib/features/notifications/push-config';
  import { NotificationCenter } from '$lib/features/notifications/notifications.svelte';
  import { rememberRoomNames } from '$lib/features/notifications/room-names';
  import { syncPushSubscription } from '$lib/features/notifications/web-push';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();
  const roomList = new RoomList(core);
  provideRoomList(roomList);
  const notifications = new NotificationCenter();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  $effect(() => {
    if (core.status === 'signed-out') {
      void goto(resolve('/login'), { replaceState: true });
    }
  });

  $effect(() => {
    document.documentElement.dataset.underlineLinks = preferences.underlineLinks ? 'on' : 'off';
  });

  // Delegated, because settings links can appear in any surface that renders a body.
  $effect(() => {
    const shallow = appLayout.matches;
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>('a[data-settings-link]');
      const section = anchor?.dataset.settingsLink;
      if (section === undefined) return;

      followSettingsLink(event, section, anchor?.dataset.settingsLinkFocus, shallow);
    };

    return on(document, 'click', onClick);
  });

  $effect(() => {
    if (core.status !== 'ready') return;

    void core.setNotificationContent(preferences.notificationContent).catch(() => {});
  });

  // Not gated on `desktopNotifications`: the native shell alerts without the
  // webview, and that switch only governs the in-app ones.
  $effect(() => {
    if (core.status !== 'ready') return;

    void registerNativePush(pushOverride()).catch((error: unknown) => {
      console.debug('[sable notifications] native push not registered', error);
    });
  });

  // The browser can rotate a subscription behind our back, so the worker asks
  // for a fresh look rather than the app polling for one.
  $effect(() => {
    if (core.status !== 'ready' || !preferences.desktopNotifications) return;

    // Read before the first await, or a retargeted gateway never re-registers.
    const override = pushOverride();

    const resync = (): void => {
      void syncPushSubscription(core, override).catch((error: unknown) => {
        console.debug('[sable notifications] push not registered', error);
      });
    };
    resync();

    return on(navigator.serviceWorker, 'message', (event) => {
      const message = (event as MessageEvent).data as
        | { type?: string; roomId?: string }
        | undefined;
      if (message?.type === 'sable:push-resubscribe') resync();
      if (message?.type === 'sable:open-room' && message.roomId !== undefined) {
        void goto(resolve('/(app)/home/[roomId]', { roomId: roomPathParamFromId(message.roomId) }));
      }
    });
  });

  $effect(() => {
    const names = new Map(
      roomList.rooms
        .filter((room) => room.name !== null)
        .map((room) => [room.room_id, room.name ?? room.room_id])
    );
    if (names.size === 0) return;

    void rememberRoomNames(names).catch(() => {});
  });

  $effect(() => {
    if (core.status !== 'ready') return;

    void roomList.start();
    notifications.start(core);
    return () => {
      roomList.stop();
      notifications.stop();
    };
  });
</script>

{#if core.status === 'ready'}
  <AppShell>
    {@render children()}
  </AppShell>
  {#if page.state.settings}
    <SettingsPanel shallow section={page.state.settings.section} />
  {/if}
{:else if core.status === 'error'}
  <main class="app-status" aria-labelledby="app-status-title">
    <div class="app-status-card" role="alert">
      <h1 id="app-status-title">{$i18n.t('app.unableToStart')}</h1>
      <p>{$i18n.t('app.startFailed')}</p>
      <Button onclick={() => void core.start()}>{$i18n.t('app.tryAgain')}</Button>
    </div>
  </main>
{:else}
  <main class="app-status" aria-labelledby="app-status-title" aria-busy="true">
    <div class="app-status-card" role="status">
      <Spinner />
      <h1 id="app-status-title">{$i18n.t('app.starting')}</h1>
    </div>
  </main>
{/if}

<style>
  .app-status {
    align-items: center;
    background: var(--sable-surface-container);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: 2rem 1.5rem;
  }

  .app-status-card {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-dialog);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 28rem;
    padding: 2rem;
    text-align: center;
    width: 100%;
  }

  .app-status-card h1,
  .app-status-card p {
    margin: 0;
  }

  .app-status-card h1 {
    font-size: var(--font-size-medium);
  }

  .app-status-card p {
    color: var(--sable-surface-var-on-container);
    line-height: var(--line-height-body);
  }

  .app-status-card :global(.sable-button) {
    min-width: 8rem;
  }
</style>
