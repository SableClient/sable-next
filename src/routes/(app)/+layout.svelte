<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import { page } from '$app/state';
  import AppShell from '#lib/ui/AppShell.svelte';
  import InboxPanel from '#lib/features/inbox/InboxPanel.svelte';
  import SettingsPanel from '#lib/features/settings/SettingsPanel.svelte';
  import { followSettingsLink } from '#lib/features/settings/settings-navigation.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import {
    findRoomByPathId,
    provideRoomList,
    RoomList,
    roomPathParamFromId,
  } from '#lib/rooms/room-list.svelte.js';
  import { provideSpaceSidebar, SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.js';
  import { Bookmarks, provideBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { clearDrafts } from '#lib/features/composer/composer-drafts.js';
  import { deliversWebPush } from '#lib/platform/notifications.js';
  import { startSystemBarSync } from '#lib/platform/system-bars.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { registerNativePush } from '#lib/features/notifications/native-push.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { NotificationCenter } from '#lib/features/notifications/notifications.svelte.js';
  import IncomingCallDialog from '#lib/features/call/IncomingCallDialog.svelte';
  import { IncomingCalls, type IncomingCall } from '#lib/features/call/incoming-calls.svelte.js';
  import { CallSession, provideCallSession } from '#lib/features/call/call-session.svelte.js';
  import ActiveCallBar from '#lib/features/call/ActiveCallBar.svelte';
  import { RoomNameWriter } from '#lib/features/notifications/room-names.js';
  import { syncPushSubscription } from '#lib/features/notifications/web-push.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();
  const roomList = new RoomList(core);
  provideRoomList(roomList);
  const spaceSidebar = new SpaceSidebar();
  provideSpaceSidebar(spaceSidebar);
  providePersonaStore(new PersonaStore(core));
  const bookmarks = new Bookmarks(core.commands);
  provideBookmarks(bookmarks);
  const notifications = new NotificationCenter();
  const incomingCalls = new IncomingCalls(core);
  const callSession = new CallSession(core);
  provideCallSession(callSession);

  let openRoomId = $derived(findRoomByPathId(roomList.rooms, page.params.roomId)?.room_id ?? null);
  let callRoom = $derived(
    callSession.roomId === null
      ? undefined
      : roomList.rooms.find((room) => room.room_id === callSession.roomId)
  );
  let showCallBar = $derived(callSession.active && callSession.roomId !== openRoomId);

  let incoming = $derived(incomingCalls.calls.at(0) ?? null);
  let incomingProfile = $state.raw<{ name: string; avatar: string | null } | null>(null);

  $effect(() => {
    const sender = incoming?.sender;
    if (!sender) {
      incomingProfile = null;
      return;
    }

    let cancelled = false;
    incomingProfile = { name: sender, avatar: null };
    void core
      .userProfile(sender)
      .then((profile) => {
        if (cancelled) return;
        incomingProfile = {
          name: profile.display_name ?? sender,
          avatar: profile.avatar_url,
        };
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  });
  let incomingRoom = $derived(
    incoming ? roomList.rooms.find((room) => room.room_id === incoming.roomId) : undefined
  );

  $effect(() => {
    if (core.status !== 'ready') return;
    return incomingCalls.start();
  });

  function acceptIncoming(call: IncomingCall): void {
    incomingCalls.accept(call);
    void goto(resolve('/(app)/home/[roomId]', { roomId: roomPathParamFromId(call.roomId) }));
    void callSession.join(call.roomId, { microphone: true, camera: false });
  }
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  $effect(() => {
    const login = resolve('login');
    if (core.status === 'signed-out' && !page.url.pathname.startsWith(login)) {
      clearDrafts();
      void goto(login, { replace: true });
    }
  });

  $effect(() => {
    document.documentElement.dataset.underlineLinks = preferences.underlineLinks ? 'on' : 'off';
  });

  $effect(() => {
    // The bars only matter once the shell paints under them; the observer then
    // re-samples on navigation, overlays and theme swaps by itself.
    if (core.status !== 'ready') return;
    return startSystemBarSync();
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
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void core.commands.setNotificationContent(preferences.notificationContent).catch(() => {});
  });

  // Not gated on `desktopNotifications`: the native shell alerts without the
  // webview, and that switch only governs the in-app ones.
  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void registerNativePush(pushOverride()).catch((error: unknown) => {
      console.debug('[sable notifications] native push not registered', error);
    });
  });

  // The browser can rotate a subscription behind our back, so the worker asks
  // for a fresh look rather than the app polling for one.
  $effect(() => {
    if (core.status !== 'ready' || !preferences.desktopNotifications || !deliversWebPush()) return;

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

  const roomNames = new RoomNameWriter();

  $effect(() => {
    const names = new Map(
      roomList.rooms
        .filter((room) => room.name !== null)
        .map((room) => [room.room_id, room.name ?? room.room_id])
    );
    if (names.size === 0) return;

    roomNames.remember(names);
  });

  onDestroy(() => {
    roomNames.dispose();
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void roomList.start();
    void spaceSidebar.start(core);
    notifications.start(core);
    return () => {
      roomList.stop();
      spaceSidebar.stop();
      notifications.stop();
    };
  });
</script>

{#if core.status === 'ready'}
  {#key core.accountRevision}
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <AppShell>
      {@render children()}
    </AppShell>
    {#if showCallBar}
      <div class="call-dock">
        <ActiveCallBar
          session={callSession}
          roomName={callRoom?.name ?? $i18n.t('call.title')}
          onReturn={() => {
            if (callSession.roomId === null) return;
            void goto(
              resolve('/(app)/home/[roomId]', {
                roomId: roomPathParamFromId(callSession.roomId),
              })
            );
          }}
        />
      </div>
    {/if}
    <IncomingCallDialog
      call={incoming}
      senderName={incomingProfile?.name ?? incoming?.sender ?? ''}
      senderAvatar={incomingProfile?.avatar ?? null}
      roomName={incomingRoom?.name ?? incoming?.roomId ?? ''}
      onAccept={acceptIncoming}
      onDecline={(call: IncomingCall) => void incomingCalls.decline(call)}
    />
    {#if page.state.settings}
      <SettingsPanel shallow section={page.state.settings.section} />
    {/if}
    {#if page.state.inbox}
      <InboxPanel />
    {/if}
  {/key}
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
  .skip-link {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-primary-main);
    border-radius: var(--radius);
    color: var(--sable-bg-on-container);
    left: var(--space-2);
    padding: var(--space-2) var(--space-3);
    position: fixed;
    top: var(--space-2);
    transform: translateY(-150%);
    z-index: var(--layer-tooltip);
  }

  .skip-link:focus-visible {
    transform: translateY(0);
  }

  .app-status {
    align-items: center;
    background: var(--sable-surface-container);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700) var(--space-600);
  }

  .app-status-card {
    align-items: center;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    max-width: 28rem;
    padding: var(--space-700);
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

  .call-dock {
    display: flex;
    inset-block-end: var(--space-400);
    inset-inline: 0;
    justify-content: center;
    pointer-events: none;
    position: fixed;
    z-index: 5;
  }

  .call-dock > :global(*) {
    pointer-events: auto;
  }
</style>
