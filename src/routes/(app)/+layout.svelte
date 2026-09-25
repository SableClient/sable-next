<script lang="ts">
  import { onMount } from 'svelte';
  import { onDestroy, tick, type Snippet, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { page } from '$app/state';
  import AppShell from '#lib/ui/AppShell.svelte';
  import InboxPanel from '#lib/features/inbox/InboxPanel.svelte';
  import SettingsPanel from '#lib/features/settings/SettingsPanel.svelte';
  import { followSettingsLink } from '#lib/features/settings/settings-navigation.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { findRoomByPathId, provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { provideSpaceSidebar, SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.js';
  import { Bookmarks, provideBookmarks } from '#lib/features/room/bookmarks.svelte.js';
  import { contextSearchPath } from '#lib/features/room/room-navigation.js';
  import { MESSAGE_SEARCH_FIELD_ID } from '#lib/features/search/message-search.svelte.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { PresenceStore, providePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { clearDrafts } from '#lib/features/composer/composer-drafts.svelte.js';
  import { resetUrlPreviews } from '#lib/features/room/link-preview-cache.js';
  import { rememberAfterLogin } from '#lib/auth/after-login.js';
  import { watchScheduledQueue } from '#lib/features/composer/scheduled-sender.js';
  import {
    alertsNatively,
    setNativeEncryptedContentAllowed,
    watchNativePushTokens,
    watchNativeNotificationActions,
    watchNativeNotificationClicks,
  } from '#lib/platform/native-notifications.js';
  import { deliversWebPush } from '#lib/platform/notifications.js';
  import { hostsServiceWorker } from '#lib/platform/service-worker.js';
  import { openExternalUrl, opensExternalUrls } from '#lib/platform/external-links.js';
  import { watchWindowFocus } from '#lib/platform/window-decorations.js';
  import { setUnreadBadge } from '#lib/platform/badge.js';
  import { type FaviconState, faviconState, setFavicon } from '#lib/ui/favicon.js';
  import idleFavicon from '#lib/assets/favicon.png';
  import unreadFavicon from '#lib/assets/res/svg/unread.svg';
  import highlightFavicon from '#lib/assets/res/svg/highlight.svg';
  import { startSystemBarSync } from '#lib/platform/system-bars.js';
  import { ensureAndroidHistoryRoot } from '#lib/platform/android-back.js';
  import {
    preferences,
    readReceiptIsPrivate,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import { accountSync } from '#lib/settings/account-sync.svelte.js';
  import {
    draftsDocument,
    recentEmojiDocument,
    scheduledDocument,
    settingsDocument,
    workspaceDocument,
  } from '#lib/settings/sync-documents.js';
  import {
    registerNativePush,
    unregisterNativePush,
  } from '#lib/features/notifications/native-push.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import {
    callNotificationAction,
    openNativeNotification,
    performNotificationAction,
  } from '#lib/features/notifications/native-actions.js';
  import {
    NotificationCenter,
    provideNotificationCenter,
  } from '#lib/features/notifications/notifications.svelte.js';
  import IncomingCallDialog from '#lib/features/call/IncomingCallDialog.svelte';
  import { IncomingCalls, type IncomingCall } from '#lib/features/call/incoming-calls.svelte.js';
  import { CallSession, provideCallSession } from '#lib/features/call/call-session.svelte.js';
  import { effectiveVolume } from '#lib/features/call/participant-volumes.svelte.js';
  import { ringtoneVolume, startRingback } from '#lib/features/call/ringtone.js';
  import {
    putPushContentPolicy,
    putRoomModes,
    RoomNameWriter,
  } from '#lib/features/notifications/room-names.js';
  import {
    dropPushSubscription,
    syncPushSubscription,
  } from '#lib/features/notifications/web-push.js';
  import CommandPalette from '#lib/ui/shortcuts/CommandPalette.svelte';
  import ToastRegion from '#lib/ui/ToastRegion.svelte';
  import ShareTargetSheet from '#lib/features/share/ShareTargetSheet.svelte';
  import { ShareInbox, watchSharedContent } from '#lib/features/share/share-inbox.svelte.js';
  import ShortcutsHelpDialog from '#lib/ui/shortcuts/ShortcutsHelpDialog.svelte';
  import { registerGlobalShortcuts } from '#lib/ui/shortcuts/global-shortcuts.js';
  import { paletteState, shortcutsHelpState } from '#lib/ui/shortcuts/palette-state.svelte.js';
  import { unreadRoomsByPriority } from '#lib/ui/shortcuts/room-jump.js';
  import { markRoomsRead } from '#lib/features/sidebar/nav-rooms.js';
  import { hasUnread } from '#lib/rooms/unread.js';
  import { roomAtOffset } from '#lib/features/sidebar/visible-rooms.svelte.js';

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
  const presence = new PresenceStore();
  providePresenceStore(presence);
  const notifications = new NotificationCenter();
  provideNotificationCenter(notifications);
  const incomingCalls = new IncomingCalls(core);
  const callSession = new CallSession(core);
  provideCallSession(callSession);

  let callUserIds = $derived(
    new Map(callSession.members.map((member) => [member.identity, member.user_id]))
  );
  const callVolumeOf = (identity: string): number =>
    effectiveVolume(callUserIds.get(identity) ?? identity);
  const shareInbox = new ShareInbox();

  let openRoomId = $derived(findRoomByPathId(roomList.rooms, page.params.roomId)?.room_id ?? null);
  let incoming = $derived(incomingCalls.calls.at(0) ?? null);
  let incomingProfile = $state.raw<{ name: string; avatar: string | null } | null>(null);
  let loadingAnimal = $derived(preferences.loadingAnimal || null);

  $effect(() => {
    const userId = core.session?.user_id;
    if (core.status !== 'ready' || !userId) return;

    let cancelled = false;
    void core
      .userProfile(userId)
      .then((profile) => {
        if (!cancelled) setPreference('loadingAnimal', profile.animal?.is_animal ?? '');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const sender = incoming?.sender;
    if (!sender) {
      incomingProfile = null;
      return;
    }

    let cancelled = false;
    incomingProfile = { name: incoming?.senderName ?? sender, avatar: null };
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
  let incomingRoom = $derived(incoming ? roomList.byId(incoming.roomId) : undefined);

  $effect(() => {
    if (core.status !== 'ready') return;
    return incomingCalls.start();
  });

  function acceptIncoming(call: IncomingCall): void {
    incomingCalls.accept(call);
    void goto(roomSectionPath(roomList.rooms, call.roomId));
    void callSession.join(call.roomId, { microphone: true, camera: call.hasVideo });
  }

  function answerFromNotification(
    roomId: string,
    eventId: string | null,
    outcome: 'answer' | 'decline'
  ): void {
    const known = incomingCalls.calls.find((call) => call.notificationEventId === eventId);
    if (known) {
      if (outcome === 'answer') acceptIncoming(known);
      else void incomingCalls.decline(known);
      return;
    }
    if (outcome === 'decline') {
      if (eventId !== null) void core.commands.declineCall(roomId, eventId).catch(() => {});
      return;
    }
    void goto(roomSectionPath(roomList.rooms, roomId));
    void callSession.join(roomId, { microphone: true, camera: false });
  }
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  let wasSignedIn = false;

  $effect(() => {
    const login = resolve('login');
    if (core.status === 'ready') wasSignedIn = true;
    if (core.status === 'signed-out' && !page.url.pathname.startsWith(login)) {
      untrack(clearDrafts);
      resetUrlPreviews();
      const account = core.accounts.find(
        (account) => account.account_id === core.reauthenticationAccountId
      );
      if (account || !wasSignedIn) rememberAfterLogin(page.url);
      const target = account
        ? resolve(
            `login?reauth=${encodeURIComponent(account.account_id)}&server=${encodeURIComponent(account.homeserver)}`
          )
        : login;
      void goto(target, { replace: true });
    }
  });

  $effect(() => {
    document.documentElement.dataset.underlineLinks = preferences.underlineLinks ? 'on' : 'off';
  });

  const syncDocuments = [
    settingsDocument,
    workspaceDocument(spaceSidebar),
    draftsDocument,
    recentEmojiDocument,
    scheduledDocument,
  ];

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready' || !preferences.settingsSync) return;

    return accountSync.start(core, syncDocuments);
  });

  for (const synced of syncDocuments) {
    $effect(() => {
      accountSync.push(synced);
    });
  }

  const FAVICONS: Record<FaviconState, string> = {
    idle: idleFavicon,
    unread: unreadFavicon,
    highlight: highlightFavicon,
  };

  let countedRooms = $derived(
    roomList.rooms.filter((room) => room.state === 'joined' && !room.is_space)
  );
  let unreadTotal = $derived(
    countedRooms.reduce((total, room) => total + roomList.notificationsFor(room).highlight, 0)
  );

  $effect(() => {
    void setUnreadBadge(unreadTotal);
  });

  $effect(() => {
    if (!preferences.outgoingRingback) return;
    if (callSession.lifecycle !== 'active') return;
    if (callSession.transport.participants.length > 0) return;
    if (!roomList.byId(callSession.roomId)?.is_direct) return;

    const ringback = startRingback(ringtoneVolume(preferences.callRingtoneVolume));
    return () => {
      ringback.stop();
    };
  });

  $effect(() => {
    const state = faviconState(
      countedRooms.some((room) => hasUnread(roomList.notificationsFor(room))),
      unreadTotal > 0,
      preferences.faviconForMentionsOnly
    );
    setFavicon(FAVICONS[state]);
  });

  $effect(() => {
    // The bars only matter once the shell paints under them; the observer then
    // re-samples on navigation, overlays and theme swaps by itself.
    if (core.status !== 'ready') return;
    return startSystemBarSync();
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    ensureAndroidHistoryRoot(resolve('/(app)/rooms'));
  });

  $effect(() => {
    const shallow = appLayout.matches;
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>('a');
      if (!anchor) return;

      const section = anchor.dataset.settingsLink;
      if (section !== undefined) {
        followSettingsLink(event, section, anchor.dataset.settingsLinkFocus, shallow);
        return;
      }

      if (anchor.target !== '_blank' || event.button > 1) return;
      if (!opensExternalUrls()) return;
      if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return;

      event.preventDefault();
      const href = anchor.href;
      void openExternalUrl(href).catch((error: unknown) => {
        console.warn('[sable links] external link unavailable', href, error);
      });
    };

    const offClick = on(document, 'click', onClick);
    const offAuxClick = on(document, 'auxclick', onClick);
    return () => {
      offClick();
      offAuxClick();
    };
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void core.commands
      .setNotificationContent(
        preferences.notificationContent,
        preferences.notificationEncryptedContent
      )
      .catch(() => {});

    void core.commands.setNotificationSounds(preferences.notificationSounds).catch(() => {});

    void core.commands.setNotifyOnce(preferences.notifyOnce).catch(() => {});

    void core.commands.setNotificationsEnabled(preferences.systemNotifications).catch(() => {});

    void setNativeEncryptedContentAllowed(
      preferences.notificationContent && preferences.notificationEncryptedContent,
      preferences.notificationContent,
      preferences.systemNotifications,
      preferences.notificationSounds,
      preferences.notifyOnce
    ).catch(() => {});

    void putPushContentPolicy({
      content: preferences.notificationContent,
      encryptedContent: preferences.notificationEncryptedContent,
      notifyOnce: preferences.notifyOnce,
    });
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    const message = preferences.presenceStatusMessage.trim();
    void core.commands
      .setPresence(
        preferences.sendPresence ? preferences.presence : 'offline',
        preferences.sendPresence && message ? message : null
      )
      .catch(() => {});
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    if (!preferences.systemNotifications) {
      void unregisterNativePush().catch((error: unknown) => {
        console.debug('[sable notifications] native push not unregistered', error);
      });
      return;
    }

    void registerNativePush(pushOverride(), core.session, core.accounts).catch((error: unknown) => {
      console.debug('[sable notifications] native push not registered', error);
    });
  });

  onMount(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void watchNativePushTokens(() => {
      if (core.status === 'ready' && preferences.systemNotifications) {
        void registerNativePush(pushOverride(), core.session, core.accounts).catch(
          (error: unknown) => {
            console.debug('[sable notifications] rotated token not registered', error);
          }
        );
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  });

  $effect(() => {
    if (core.status !== 'ready' || preferences.systemNotifications || !deliversWebPush()) return;

    void dropPushSubscription(core, pushOverride()).catch((error: unknown) => {
      console.debug('[sable notifications] push not dropped', error);
    });
  });

  // The browser can rotate a subscription behind our back, so the worker asks
  // for a fresh look rather than the app polling for one.
  $effect(() => {
    if (core.status !== 'ready' || !preferences.systemNotifications || !deliversWebPush()) return;

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
        | { type?: string; appId?: string; ackToken?: string }
        | undefined;

      if (message?.type === 'sable:push-resubscribe') resync();
      if (message?.type === 'sable:webpush-ack') {
        if (message.appId && message.ackToken) {
          void core.commands.ackWebPusher(message.appId, message.ackToken).catch(() => undefined);
        }
      }
    });
  });

  let pushedRoom = $state<{
    roomId: string;
    userId: string | null;
    eventId: string | null;
  } | null>(null);

  $effect(() => {
    if (!hostsServiceWorker()) return;

    return on(navigator.serviceWorker, 'message', (event) => {
      const message = (event as MessageEvent).data as
        | { type?: string; roomId?: string; userId?: string; eventId?: string }
        | undefined;
      if (message?.type === 'sable:open-room' && message.roomId !== undefined) {
        pushedRoom = {
          roomId: message.roomId,
          userId: message.userId ?? null,
          eventId: message.eventId ?? null,
        };
      }
    });
  });

  $effect(() => {
    if (core.status !== 'ready' || pushedRoom === null) return;

    const { roomId, userId, eventId } = pushedRoom;
    pushedRoom = null;
    const opened =
      userId === null
        ? openNotification(roomId, eventId)
        : openNativeNotification(core, { userId, roomId, eventId }, openNotification);
    void opened.catch((error: unknown) => {
      console.debug('[sable notifications] notification not opened', error);
    });
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    return watchScheduledQueue(core);
  });

  $effect(() => {
    const stop = watchSharedContent(shareInbox);
    if (!('serviceWorker' in navigator)) return stop;

    const off = on(navigator.serviceWorker, 'message', (event) => {
      const message = (event as MessageEvent).data as
        | { type?: string; text?: string; files?: File[] }
        | undefined;
      if (message?.type === 'sable:share')
        shareInbox.accept(message.text ?? '', message.files ?? []);
    });
    navigator.serviceWorker.controller?.postMessage({ type: 'sable:share-take' });

    return () => {
      off();
      stop();
    };
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

  const roomModes = new RoomNameWriter(putRoomModes);

  $effect(() => {
    const modes = new Map(
      roomList.rooms.flatMap((room) => {
        const mode = roomList.notificationMode(room.room_id);
        return mode === null ? [] : [[room.room_id, mode] as const];
      })
    );
    if (modes.size === 0) return;

    roomModes.remember(modes);
  });

  onDestroy(() => {
    roomNames.dispose();
    roomModes.dispose();
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void roomList.start();
    void spaceSidebar.start(core);
    notifications.start(core, openNotification);
    presence.start(core);
    dismissedInvites.start(core);
    return () => {
      roomList.stop();
      spaceSidebar.stop();
      notifications.stop();
      presence.stop();
      dismissedInvites.stop();
    };
  });

  async function openNotification(roomId: string, eventId: string | null): Promise<void> {
    await tick();
    await roomList.start();
    await goto(roomSectionPath(roomList.rooms, roomId), {
      state: eventId === null ? {} : { notified: eventId },
    });
  }

  $effect(() => {
    if (core.status !== 'ready' || !roomList.settled) return;
    notifications.retireRead(roomList.rooms, roomList.notificationsFor);
  });

  let documentVisible = $state(true);
  let windowFocused = $state(true);
  let visible = $derived(documentVisible && windowFocused);

  $effect(() => {
    const read = () => {
      documentVisible = document.visibilityState === 'visible';
    };
    read();
    return on(document, 'visibilitychange', read);
  });

  $effect(() => {
    let stopped = false;
    let unlisten = () => {};
    void watchWindowFocus((focused) => {
      windowFocused = focused;
    }).then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    });
    return () => {
      stopped = true;
      unlisten();
    };
  });

  $effect(() => {
    roomList.setPresentationActive(visible);
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    notifications.readRoom(visible ? openRoomId : null);
  });

  $effect(() => {
    if (core.status !== 'ready' || !alertsNatively()) return;

    let stop: (() => void) | null = null;
    let stopped = false;

    void Promise.all([
      watchNativeNotificationActions((action) => {
        const call = callNotificationAction(action);
        if (call !== null) {
          answerFromNotification(action.roomId, action.eventId, call);
          return;
        }
        void performNotificationAction(core, action, readReceiptIsPrivate()).catch(
          (error: unknown) => {
            console.debug('[sable notifications] action not performed', error);
          }
        );
      }),
      watchNativeNotificationClicks((target) => {
        void openNativeNotification(core, target, openNotification).catch((error: unknown) => {
          console.debug('[sable notifications] notification not opened', error);
        });
      }),
    ])
      .then((offs) => {
        stop = () => {
          for (const off of offs) off();
        };
        if (stopped) stop();
      })
      .catch((error: unknown) => {
        console.debug('[sable notifications] native listeners not attached', error);
      });

    return () => {
      stopped = true;
      stop?.();
    };
  });

  let unreadCycleIndex = 0;

  function jumpToRoom(roomId: string): void {
    void goto(roomSectionPath(roomList.rooms, roomId));
  }

  $effect(() => {
    return registerGlobalShortcuts({
      'navigation.openRoomSearch': () => {
        paletteState.open = true;
      },
      'app.searchMessages': () => {
        if (page.url.pathname.startsWith(resolve('search'))) {
          document.getElementById(MESSAGE_SEARCH_FIELD_ID)?.focus();
          return;
        }
        void goto(contextSearchPath(roomList.rooms, page.params.roomId, page.params.spaceId));
      },
      'app.openBookmarks': () => {
        void goto(resolve('bookmarks'));
      },
      'app.createRoom': () => {
        void goto(resolve('create-room'));
      },
      'app.showShortcuts': () => {
        shortcutsHelpState.open = true;
      },
      'call.toggleMute': () => {
        if (callSession.active && callSession.mediaReady) {
          void callSession.setMicrophoneEnabled(!callSession.transport.microphoneEnabled);
        }
      },
      'call.toggleDeafen': () => {
        if (callSession.active) callSession.setDeafened(!callSession.deafened);
      },
      'call.toggleCamera': () => {
        if (callSession.active && callSession.mediaReady) {
          void callSession.setCameraEnabled(!callSession.transport.cameraEnabled);
        }
      },
      'call.toggleScreenShare': () => {
        if (callSession.active && callSession.mediaReady && callSession.canScreenShare) {
          void callSession.setScreenShareEnabled(!callSession.transport.screenShareEnabled);
        }
      },
      'call.hangUp': () => {
        if (callSession.active) void callSession.leave();
      },
      'app.openSettings': () => {
        void goto(resolve('/(app)/settings'));
      },
      'navigation.previousRoom': () => {
        const target = roomAtOffset(openRoomId, -1);
        if (target) jumpToRoom(target);
      },
      'navigation.nextRoom': () => {
        const target = roomAtOffset(openRoomId, 1);
        if (target) jumpToRoom(target);
      },
      'room.markRead': () => {
        const room = roomList.byId(openRoomId);
        markRoomsRead([room], core.commands, readReceiptIsPrivate());
      },
      'room.markAllRead': () => {
        markRoomsRead(roomList.rooms, core.commands, readReceiptIsPrivate());
      },
      'navigation.nextUnread': () => {
        const unread = unreadRoomsByPriority(roomList.rooms, openRoomId, roomList.unreadFor);
        const target = unread[0];
        if (!target) return;
        unreadCycleIndex = 0;
        jumpToRoom(target.room_id);
      },
      'navigation.cycleNextUnread': () => {
        const unread = unreadRoomsByPriority(roomList.rooms, null, roomList.unreadFor);
        if (unread.length === 0) return;
        unreadCycleIndex = (unreadCycleIndex + 1) % unread.length;
        const target = unread[unreadCycleIndex];
        if (target) jumpToRoom(target.room_id);
      },
      'navigation.cyclePreviousUnread': () => {
        const unread = unreadRoomsByPriority(roomList.rooms, null, roomList.unreadFor);
        if (unread.length === 0) return;
        unreadCycleIndex = (unreadCycleIndex - 1 + unread.length) % unread.length;
        const target = unread[unreadCycleIndex];
        if (target) jumpToRoom(target.room_id);
      },
    });
  });
</script>

{#if core.status === 'ready'}
  {#key core.accountRevision}
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <AppShell>
      {@render children()}
    </AppShell>
    {#if callSession.rooms.length > 0}
      {#await import('#lib/features/call/CallAudio.svelte') then { default: CallAudio }}
        {#each callSession.rooms as entry (entry.backendId)}
          <CallAudio
            room={entry.room}
            telemetry={callSession.telemetry}
            deafened={callSession.deafened}
            volumeOf={callVolumeOf}
          />
        {/each}
      {/await}
    {/if}
    <IncomingCallDialog
      call={incoming}
      senderName={incomingProfile?.name ?? incoming?.sender ?? ''}
      senderAvatar={incomingProfile?.avatar ?? null}
      roomName={incomingRoom?.name ?? incoming?.roomName ?? incoming?.roomId ?? ''}
      onAccept={acceptIncoming}
      onDecline={(call: IncomingCall) => void incomingCalls.decline(call)}
    />
    {#if page.state.settings}
      <SettingsPanel
        shallow
        section={page.state.settings.section}
        focus={page.state.settings.focus}
      />
    {/if}
    {#if page.state.inbox}
      <InboxPanel />
    {/if}
    <CommandPalette bind:open={paletteState.open} />
    <ShortcutsHelpDialog bind:open={shortcutsHelpState.open} />
    <ShareTargetSheet inbox={shareInbox} />
    <ToastRegion dismissLabel={$i18n.t('errors.dismissToast')} />
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
      <h1 id="app-status-title">
        {loadingAnimal
          ? $i18n.t('app.pettingAnimal', { animal: loadingAnimal })
          : $i18n.t('app.starting')}
      </h1>
    </div>
  </main>
{/if}

<style>
  .skip-link {
    border: 0;
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .skip-link:focus-visible {
    background: var(--bg-container);
    border: var(--border-width) solid var(--primary-main);
    border-radius: var(--radius);
    clip-path: none;
    color: var(--bg-on-container);
    height: auto;
    left: calc(var(--space-300) + var(--safe-left));
    overflow: visible;
    padding: var(--space-300) var(--space-400);
    position: fixed;
    top: calc(var(--space-300) + var(--safe-top));
    width: auto;
    z-index: var(--layer-tooltip);
  }

  .app-status {
    align-items: center;
    background: var(--surface-container);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    min-height: 100dvh;
    padding: var(--space-700) var(--space-600);
  }

  .app-status-card {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
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
    font-size: var(--font-size-heading);
  }

  .app-status-card p {
    color: var(--surface-var-on-container);
    line-height: var(--line-height-body);
  }

  .app-status-card :global(.btn) {
    min-width: 8rem;
  }
</style>
