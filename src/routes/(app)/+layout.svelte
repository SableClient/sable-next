<script lang="ts">
  import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
  import { onDestroy, onMount, tick, type Snippet, untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { page } from '$app/state';
  import AppShell from '#lib/features/sidebar/AppShell.svelte';
  import SettingsPanel from '#lib/features/settings/SettingsPanel.svelte';
  import {
    defaultSettingsSection,
    followSettingsLink,
    showSettingsOver,
  } from '#lib/features/settings/settings-navigation.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import {
    findRoomByPathId,
    provideRoomList,
    RoomList,
    roomListOptions,
  } from '#lib/rooms/room-list.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { HOME_SECTION, rememberLastRoom } from '#lib/rooms/last-room.js';
  import { provideSpaceSidebar, SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import { OpenRoomSearch, provideOpenRoomSearch } from '#lib/features/room/room-panels.svelte.js';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.js';
  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import { EventItems, provideEventItems } from '#lib/features/room/messages/event-items.svelte.js';
  import {
    provideRoomScopes,
    RoomScopes,
  } from '#lib/features/room/messages/message-scope.svelte.js';
  import {
    backToRoomList,
    contextSearchPath,
    createRoomPath,
    trackRouteFocus,
  } from '#lib/features/room/room-navigation.js';
  import { MESSAGE_SEARCH_FIELD_ID } from '#lib/features/search/message-search.svelte.js';
  import { InviteActions } from '#lib/rooms/invites.svelte.js';
  import { dismissedInvites } from '#lib/rooms/dismissed-invites.svelte.js';
  import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
  import { presenceOverride } from '#lib/rooms/presence-override.svelte.js';
  import { dmSpaces } from '#lib/rooms/dm-spaces.svelte.js';
  import { spaceNotifications } from '#lib/rooms/space-notifications.svelte.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { supporter } from '#lib/supporter/supporter.svelte.js';
  import { PresenceStore, providePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { afterNavigate, goto, onNavigate } from '$app/navigation';
  import { tabTransition } from '#lib/ui/tab-transition.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { resolve } from '$app/paths';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { clearDrafts } from '#lib/composer/composer-drafts.svelte.js';
  import { resetUrlPreviews } from '#lib/features/room/media/link-preview-cache.js';
  import { rememberAfterLogin } from '#lib/auth/after-login.js';
  import { hasPendingSetup } from '#lib/features/auth/setup/setup-record.js';
  import { readText } from '#lib/platform/local-json.js';
  import { watchScheduledQueue } from '#lib/features/composer/scheduled-sender.js';
  import { watchSearchPeers } from '#lib/search/search-peer.js';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import {
    alertsNatively,
    forgetLeftNativeConversations,
    setNativeNotificationPolicy,
    watchNativePushTokens,
    watchNativeNotificationActions,
    watchNativeNotificationClicks,
    type NativeNotificationTarget,
  } from '#lib/platform/native-notifications.js';
  import { deliversWebPush } from '#lib/platform/notifications.js';
  import { hostsServiceWorker } from '#lib/platform/service-worker.js';
  import { followExternalLink } from '#lib/platform/external-links.js';
  import { windowActivity } from '#lib/platform/window-activity.js';
  import { watchNetworkConditions } from '#lib/platform/network-conditions.js';
  import { isNativeMobile } from '#lib/platform/os.js';
  import { setUnreadBadge } from '#lib/platform/badge.js';
  import { keepStorage } from '#lib/platform/persistent-storage.js';
  import { electronBridge, type ScreenShareCandidate } from '#lib/platform/electron.js';
  import { type FaviconState, faviconState, setFavicon } from '#lib/ui/favicon.js';
  import { faviconUrl } from '#lib/deployment/brand.js';
  import idleFavicon from '#lib/assets/favicon.png';
  import unreadFavicon from '#lib/assets/res/svg/unread.svg';
  import highlightFavicon from '#lib/assets/res/svg/highlight.svg';
  import { startSystemBarSync } from '#lib/platform/system-bars.js';
  import { installAndroidBack } from '#lib/platform/android-back.js';
  import {
    selectPreferenceAccount,
    preferences,
    readReceiptIsPrivate,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import { accountSync } from '#lib/settings/account-sync.svelte.js';
  import {
    draftsDocumentFor,
    scheduledDocumentFor,
    settingsDocument,
    workspaceDocument,
  } from '#lib/settings/sync-documents.js';
  import {
    registerNativePush,
    retryNativePushNow,
    unregisterNativePush,
  } from '#lib/features/notifications/native-push.js';
  import { pushOverride } from '#lib/notifications/push-config.js';
  import { unregisterVoipPusher } from '#lib/features/notifications/voip-push.js';
  import {
    callNotificationAction,
    inviteNotificationAction,
    NativeNotificationOpener,
    type NativeNotificationOpen,
    selectNotificationAccount,
    performNotificationAction,
  } from '#lib/features/notifications/native-actions.js';
  import { trackNotificationOpening } from '#lib/features/notifications/notification-opening.svelte.js';
  import {
    NotificationCenter,
    provideNotificationCenter,
  } from '#lib/features/notifications/notifications.svelte.js';
  import IncomingCallDialog from '#lib/features/call/IncomingCallDialog.svelte';
  import {
    IncomingCalls,
    type IncomingCall,
    type SystemAnswer,
  } from '#lib/features/call/incoming-calls.svelte.js';
  import { CallSession, provideCallSession } from '#lib/features/call/call-session.svelte.js';
  import { SystemCalls } from '#lib/features/call/system-calls.svelte.js';
  import {
    effectiveVolume,
    screenVolumeKey,
  } from '#lib/features/call/participant-volumes.svelte.js';
  import {
    boundServerIdentity,
    currentServerUser,
    forgetPushSessions,
    PUSH_ACTIVATION_TTL_MS,
    putPushContentPolicy,
    putRoomModes,
    RoomNameWriter,
  } from '#lib/notifications/room-names.js';
  import {
    dropPushSubscription,
    pusherDisplayName,
    syncPushSubscription,
  } from '#lib/features/notifications/web-push.js';
  import { answerPushEvent, sharePushSession } from '#lib/features/notifications/push-session.js';
  import { onPermissionGranted } from '#lib/features/notifications/present.js';
  import { clearPushFailure, recordPushFailure } from '#lib/features/notifications/push-failure.js';
  import CommandPalette from '#lib/ui/shortcuts/CommandPalette.svelte';
  import ToastRegion from '#lib/ui/ToastRegion.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import ShareTargetSheet from '#lib/features/share/ShareTargetSheet.svelte';
  import { ShareInbox, watchSharedContent } from '#lib/features/share/share-inbox.svelte.js';
  import ShortcutsHelpDialog from '#lib/ui/shortcuts/ShortcutsHelpDialog.svelte';
  import { cycleRegion, focusRegion } from '#lib/ui/shortcuts/focus-regions.js';
  import { registerGlobalShortcuts } from '#lib/ui/shortcuts/global-shortcuts.js';
  import { registerDesktopCallShortcuts } from '#lib/features/call/desktop-shortcuts.svelte.js';
  import { paletteState, shortcutsHelpState } from '#lib/ui/shortcuts/palette-state.svelte.js';
  import { unreadRoomAtOffset, unreadRoomsByPriority } from '#lib/ui/shortcuts/room-jump.js';
  import { markRoomsRead } from '#lib/features/sidebar/nav-rooms.js';
  import { hasUnread } from '#lib/rooms/unread.js';
  import { roomAtOffset } from '#lib/features/sidebar/visible-rooms.svelte.js';
  import { playSound, type NotificationSound } from '#lib/features/notifications/sound.js';
  import MediaViewerHost from '#lib/ui/media/MediaViewerHost.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const core = useCoreClient();
  const notificationOpener = new NativeNotificationOpener(core);
  onDestroy(() => notificationOpener.cancel());
  let stopSearchPeers: (() => void) | null = null;
  let searchPeerKey: string | null = null;
  let searchOptionsReady: Promise<unknown> = Promise.resolve();
  onDestroy(() => stopSearchPeers?.());
  const roomList = new RoomList(core);
  provideRoomList(roomList);
  $effect(() => {
    roomList.setOptions(roomListOptions());
  });
  const spaceSidebar = new SpaceSidebar();
  provideSpaceSidebar(spaceSidebar);
  const openRoomSearch = new OpenRoomSearch();
  provideOpenRoomSearch(openRoomSearch);
  providePersonaStore(new PersonaStore(core));
  const bookmarks = new Bookmarks(core.rpc.account);
  provideBookmarks(bookmarks);
  provideEventItems(new EventItems(core.rpc.timeline, () => core.session?.user_id ?? null));
  const roomScopes = new RoomScopes(core);
  provideRoomScopes(roomScopes);
  onDestroy(() => roomScopes.dispose());
  const presence = new PresenceStore();
  providePresenceStore(presence);
  const notifications = new NotificationCenter();
  provideNotificationCenter(notifications);
  const callSession = new CallSession(core, {
    roomName: (roomId) => roomList.byId(roomId)?.name,
  });
  provideCallSession(callSession);
  onMount(() => registerDesktopCallShortcuts(callSession));
  $effect(() => {
    const inputMode = preferences.callInputMode;
    untrack(() => callSession.setInputMode(inputMode));
  });
  $effect.pre(() => {
    selectPreferenceAccount(core.session?.account_id ?? null);
  });
  $effect(() => {
    void core.accountRevision;
    return () => void callSession.leave();
  });
  let screenSharePick = $state.raw<{
    sources: ScreenShareCandidate[];
    settle: (id: string | null) => void;
  } | null>(null);
  $effect(() =>
    electronBridge()?.onScreenSharePick(
      (sources) =>
        new Promise((resolve) => {
          screenSharePick = {
            sources,
            settle: (id) => {
              screenSharePick = null;
              resolve(id);
            },
          };
        })
    )
  );
  const systemCalls = new SystemCalls(callSession);
  systemCalls.track();
  const incomingCalls = new IncomingCalls(core, (answer) => void joinSystemAnswer(answer));

  async function joinSystemAnswer({ uuid, callId, roomId, hasVideo }: SystemAnswer): Promise<void> {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void goto(roomSectionPath(roomList.rooms, roomId));
    await systemCalls.answer(uuid, callId, roomId, () =>
      callSession.join(roomId, {
        microphone: !preferences.callMicrophoneMuted,
        camera: hasVideo,
      })
    );
  }

  let callUserIds = $derived(
    new Map(callSession.members.map((member) => [member.identity, member.user_id]))
  );
  const callVolumeOf = (identity: string, screen: boolean): number => {
    const userId = callUserIds.get(identity) ?? identity;
    if (!screen) return effectiveVolume(userId);
    const watched = callSession.transport.participants.some(
      (participant) =>
        participant.identity === identity &&
        participant.screenShare !== undefined &&
        callSession.watchedScreenShareIds.includes(participant.screenShare.id)
    );
    return watched ? effectiveVolume(screenVolumeKey(userId)) : 0;
  };
  const shareInbox = new ShareInbox();

  let openRoomId = $derived(findRoomByPathId(roomList.rooms, page.params.roomId)?.room_id ?? null);

  let routeAccountId = $state<string | null>(null);
  afterNavigate(() => {
    routeAccountId = core.session?.account_id ?? null;
  });
  $effect(() => {
    if (routeAccountId === null && core.session) routeAccountId = core.session.account_id;
  });
  let previousAccountRoute = $derived(
    routeAccountId !== null &&
      core.session !== null &&
      core.session.account_id !== routeAccountId &&
      (page.params.roomId !== undefined || page.params.spaceId !== undefined)
  );
  $effect(() => {
    if (previousAccountRoute) void goto(resolve('/(app)/rooms'), { replace: true });
  });

  let incoming = $derived(incomingCalls.calls.at(0) ?? null);
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
      .catch((error: unknown) => {
        console.debug('[sable profile] own profile not loaded', error);
      });
    return () => {
      cancelled = true;
    };
  });

  let incomingRoom = $derived(incoming ? roomList.byId(incoming.roomId) : undefined);

  $effect(() => {
    if (core.status !== 'ready') return;
    return incomingCalls.start();
  });

  async function acceptIncoming(call: IncomingCall): Promise<void> {
    incomingCalls.accept(call);
    void callSession.join(call.roomId, {
      microphone: !preferences.callMicrophoneMuted,
      camera: call.hasVideo,
    });
    await afterOverlayPops();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    await goto(roomSectionPath(roomList.rooms, call.roomId));
  }

  async function answerInvite(
    userId: string,
    roomId: string,
    outcome: 'accept' | 'decline'
  ): Promise<void> {
    if (!(await selectNotificationAccount(core, userId))) return;
    await tick();
    await roomList.start();
    await roomList.whenListed(roomId, NOTIFIED_ROOM_WAIT_MS);
    const invite = roomList.rooms.find((room) => room.room_id === roomId);
    if (invite?.state !== 'invited') return;
    const answers = new InviteActions(core);
    if (outcome === 'accept') await answers.accept(invite);
    else answers.decline(invite);
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
      if (eventId !== null) {
        void core.rpc.calls
          .decline({ room_id: roomId, notification_event_id: eventId })
          .catch((error: unknown) => {
            console.warn('[sable call] call not declined', error);
          });
      }
      return;
    }
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void goto(roomSectionPath(roomList.rooms, roomId));
    void callSession.join(roomId, { microphone: !preferences.callMicrophoneMuted, camera: false });
  }
  const appLayout = new AppLayout();
  onNavigate((navigation) => tabTransition(navigation, !appLayout.current));

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

  const syncDocuments = $derived([
    settingsDocument,
    workspaceDocument(spaceSidebar),
    draftsDocumentFor(core.session?.account_id ?? ''),
    scheduledDocumentFor(core.session?.account_id ?? ''),
  ]);

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready' || !preferences.settingsSync) return;

    return accountSync.start(core, syncDocuments);
  });

  $effect(() => {
    const session = core.session;
    if (core.status !== 'ready' || !session) return;
    if (hasPendingSetup({ getItem: readText }, session.user_id, session.device_id)) {
      void goto(resolve('setup'));
    }
  });

  for (const index of untrack(() => [...syncDocuments.keys()])) {
    $effect(() => {
      const synced = syncDocuments[index];
      if (synced) accountSync.push(synced);
    });
  }

  const FAVICONS: Record<FaviconState, string> = {
    idle: faviconUrl() ?? idleFavicon,
    unread: unreadFavicon,
    highlight: highlightFavicon,
  };

  let countedRooms = $derived(
    roomList.rooms.filter((room) => room.state === 'joined' && room.room_kind !== 'space')
  );
  let unreadTotal = $derived(
    countedRooms.reduce((total, room) => total + roomList.notificationsFor(room).highlight, 0)
  );
  let notifyingTotal = $derived(
    countedRooms.reduce((total, room) => total + (roomList.badgeUnreadFor(room).notifying ?? 0), 0)
  );

  $effect(() => {
    void setUnreadBadge(notifyingTotal);
  });

  let answeredCallRoom = $state<string | null>(null);

  $effect(() => {
    if (callSession.lifecycle !== 'active') answeredCallRoom = null;
    else if (callSession.transport.participants.length > 0) answeredCallRoom = callSession.roomId;
  });

  let ringback = $state<Promise<NotificationSound> | null>(null);
  const tryStopRinging = () => {
    void ringback?.then((sound) => {
      sound.stop();
      ringback = null;
    });
  };

  $effect(() => {
    if (!preferences.outgoingRingback) return;
    if (callSession.lifecycle !== 'active') {
      tryStopRinging();
      return;
    }
    if (callSession.transport.participants.length > 0) {
      tryStopRinging();
      return;
    }
    if (answeredCallRoom === callSession.roomId) return;
    if (!roomList.byId(callSession.roomId)?.is_direct) return;
    if (ringback !== null) return;
    ringback = playSound('outgoing_call', { loop: true });
  });

  // Joining and leaving our own call is announced by the session itself.
  let callParticipants: number | null = null;
  $effect(() => {
    if (callSession.lifecycle !== 'active') {
      callParticipants = null;
      return;
    }
    const count = callSession.transport.participants.length;
    if (callParticipants !== null && count > callParticipants) void playSound('call_join');
    else if (callParticipants !== null && count < callParticipants) void playSound('call_leave');
    callParticipants = count;
  });

  $effect(() => {
    const state = faviconState(
      countedRooms.some((room) => hasUnread(roomList.badgeUnreadFor(room))),
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

  $effect(() =>
    installAndroidBack({
      pathname: () => page.url.pathname,
      homePath: resolve('/(app)/rooms'),
      goHome: () => void goto(resolve('/(app)/rooms'), { replace: true }),
    })
  );

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const anchor = target.closest<HTMLAnchorElement>('a');
    if (!anchor) return;

    const section = anchor.dataset.settingsLink;
    if (section !== undefined) {
      followSettingsLink(event, section, anchor.dataset.settingsLinkFocus, appLayout.current);
      return;
    }

    followExternalLink(event, anchor);
  };

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    void core.rpc.notifications
      .setOptions({
        enabled: preferences.systemNotifications,
        content: preferences.notificationContent,
        encrypted_content: preferences.notificationEncryptedContent,
        sounds: preferences.notificationSounds,
        notify_once: preferences.notifyOnce,
      })
      .catch((error: unknown) => {
        console.warn('[sable notifications] notification settings not applied', error);
      });

    void setNativeNotificationPolicy({
      enabled: preferences.systemNotifications,
      content: preferences.notificationContent,
      encryptedContent: preferences.notificationContent && preferences.notificationEncryptedContent,
      sounds: preferences.notificationSounds,
      notifyOnce: preferences.notifyOnce,
      clearOnRead: preferences.clearNotificationsOnRead,
      privateReceipts: readReceiptIsPrivate(),
      quietWhenActiveElsewhere,
    }).catch((error: unknown) => {
      console.debug('[sable notifications] native content policy not applied', error);
    });

    void putPushContentPolicy({
      content: preferences.notificationContent,
      encryptedContent: preferences.notificationEncryptedContent,
      notifyOnce: preferences.notifyOnce,
      clearOnRead: preferences.clearNotificationsOnRead,
      quietWhenActiveElsewhere,
    });
  });

  $effect(() => {
    void core.accountRevision;
    const sharing = preferences.searchSharing && typeof RTCPeerConnection !== 'undefined';
    const peerKey =
      core.status === 'ready' && sharing
        ? `${core.session?.account_id}:${core.accountRevision}`
        : null;
    if (peerKey !== searchPeerKey) {
      stopSearchPeers?.();
      stopSearchPeers = null;
      searchPeerKey = peerKey;
    }
    if (core.status !== 'ready') return;
    let current = true;

    searchOptionsReady = core.rpc.session.setSearchOptions({
      disk_budget_mb: Number(preferences.searchIndexLimit),
      crawler: preferences.searchCrawler,
      sharing,
      unmetered_only: preferences.searchUnmeteredOnly,
      server_search: preferences.serverSearch,
      tuning: {
        crawl_pause_ms: Number(preferences.searchCrawlPause) * 1000,
        trickle_pause_ms: Number(preferences.searchTricklePause) * 1000,
        flush_interval_secs: Number(preferences.searchFlushInterval),
        batch: Number(preferences.searchBatchSize),
        base_events: Number(preferences.searchBaseEvents),
        max_events: Number(preferences.searchMaxEvents),
      },
    });
    void Promise.all([searchOptionsReady, runtimeConfig()])
      .then(([, config]) => {
        if (current && peerKey !== null && stopSearchPeers === null) {
          stopSearchPeers = watchSearchPeers(core, {
            stunServers: config.searchSharing.stunServers,
            beforeStart: async () => {
              await tick();
              await searchOptionsReady;
            },
          });
        }
      })
      .catch((error: unknown) => {
        console.warn('[sable search] search options not applied', error);
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    void core.rpc.account
      .setReadReceipts({ public: preferences.sendReadReceipts })
      .catch((error: unknown) => {
        console.warn('[sable receipts] read receipt setting not applied', error);
      });
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    void core.rpc.session
      .setAppInForeground({ foreground: documentVisible })
      .catch((error: unknown) => {
        console.debug('[sable activity] foreground not applied', error);
      });
  });

  $effect(() => {
    if (core.status !== 'ready' || isNativeMobile()) return;
    return watchNetworkConditions((conditions) => {
      void core.rpc.session.setNetworkConditions(conditions).catch((error: unknown) => {
        console.debug('[sable network] network conditions not applied', error);
      });
    });
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;

    const revised = presenceOverride.supported;
    const message = revised ? '' : preferences.presenceStatusMessage.trim();
    const picked = revised ? 'online' : preferences.presence;
    const presence = preferences.sendPresence ? picked : 'offline';
    const away = presence === 'online' && (!active || idle);
    const status = preferences.sendPresence && message ? message : null;
    const timer = setTimeout(() => {
      void core.rpc.account
        .setPresence({ presence: away ? 'unavailable' : presence, status_message: status })
        .catch((error: unknown) => {
          console.debug('[sable presence] presence not sent', error);
        });
    }, PRESENCE_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    void core.accountRevision;
    const accountId = core.session?.account_id;
    if (core.status !== 'ready' || !accountId) return;

    const write = (isActive: boolean): void => {
      deviceActivityWritten = isActive;
      void core.rpc.account.setDeviceActivity({ active: isActive }).catch((error: unknown) => {
        console.warn('[sable activity] device activity not written', error);
      });
    };
    if (preferences.pushInactiveTimeout === 'off') {
      if (deviceActivityWritten) write(false);
      return;
    }
    if (active && !idle) {
      write(true);
      const timer = setInterval(() => write(true), DEVICE_ACTIVITY_INTERVAL_MS);
      return () => clearInterval(timer);
    }

    const delay = !active && !idle ? Number(preferences.pushInactiveTimeout) * 60_000 : 0;
    const timer = setTimeout(() => write(false), delay);
    return () => {
      clearTimeout(timer);
    };
  });

  const pushDeviceName = $derived(pusherDisplayName(core));

  $effect(() => {
    void core.accountRevision;
    void pushDeviceName;
    void preferences.richPushPayloads;
    void preferences.pushEmbeddedServerUrl;
    if (core.status !== 'ready') return;
    void unregisterVoipPusher(core);

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

  $effect(() => {
    if (windowActivity.visible && core.status === 'ready' && preferences.systemNotifications) {
      void retryNativePushNow();
    }
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
      .catch((error: unknown) => {
        console.debug('[sable notifications] push token listener not attached', error);
      });
    return () => {
      disposed = true;
      stop?.();
    };
  });

  $effect(() => {
    if (core.status === 'ready') void keepStorage();
  });

  $effect(() => {
    if (core.status !== 'ready' || preferences.systemNotifications || !deliversWebPush()) return;

    void dropPushSubscription(core, pushOverride()).catch((error: unknown) => {
      console.debug('[sable notifications] push not dropped', error);
    });
  });

  $effect(() => {
    void core.session?.user_id;
    if (core.status !== 'ready' || !deliversWebPush()) return;
    // The worker acks the MSC4174 validation push with it, whatever the payload format.
    if (!preferences.systemNotifications) {
      void forgetPushSessions();
      return;
    }
    return sharePushSession(core);
  });

  $effect(() => {
    if (core.status !== 'ready' || !hostsServiceWorker()) return;

    return on(navigator.serviceWorker, 'message', (event) => {
      const message = event as MessageEvent;
      const port = message.ports[0];
      if ((message.data as { type?: unknown } | undefined)?.type !== 'sable:push-event' || !port) {
        return;
      }
      void answerPushEvent(core, message.data).then((fetched) => {
        port.postMessage(fetched);
      });
    });
  });

  // The browser can rotate a subscription behind our back, so the worker asks
  // for a fresh look rather than the app polling for one.
  $effect(() => {
    if (core.status !== 'ready' || !preferences.systemNotifications || !deliversWebPush()) return;

    // Read before the first await, or a retargeted gateway never re-registers.
    const override = pushOverride();
    void pushDeviceName;

    let synced = 0;
    const resync = (): void => {
      synced = Date.now();
      void syncPushSubscription(core, override).then(clearPushFailure, (error: unknown) => {
        recordPushFailure(error);
        console.debug('[sable notifications] push not registered', error);
      });
    };
    resync();

    // Retries a validation push missed while suspended, once its token has expired.
    const stopVisible = on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - synced >= PUSH_ACTIVATION_TTL_MS)
        resync();
    });
    const stopGranted = onPermissionGranted(resync);
    const stopMessages = on(navigator.serviceWorker, 'message', (event) => {
      const message = (event as MessageEvent).data as
        | { type?: string; appId?: string; ackToken?: string }
        | undefined;

      if (message?.type === 'sable:push-resubscribe') resync();
      if (message?.type === 'sable:webpush-ack') {
        if (message.appId && message.ackToken) {
          void core.rpc.push
            .ackWebPusher({ app_id: message.appId, ack_token: message.ackToken })
            .catch((error: unknown) => {
              console.debug('[sable notifications] web push not acknowledged', error);
            });
        }
      }
    });
    return () => {
      stopVisible();
      stopGranted();
      stopMessages();
    };
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
        | {
            type?: string;
            roomId?: string;
            userId?: string;
            eventId?: string | null;
            outcome?: 'answer' | 'decline' | 'accept';
          }
        | undefined;
      if (message?.type === 'sable:open-invites') {
        void selectNotificationAccount(core, message.userId ?? '')
          .then(() => goto(resolve('/(app)/inbox')))
          .catch((error: unknown) => {
            console.debug('[sable notifications] invites not opened', error);
          });
        return;
      }
      if (
        message?.type === 'sable:invite-action' &&
        message.roomId !== undefined &&
        message.userId !== undefined &&
        (message.outcome === 'accept' || message.outcome === 'decline')
      ) {
        const { roomId, userId, outcome } = message;
        void answerInvite(userId, roomId, outcome).catch((error: unknown) => {
          console.debug('[sable notifications] invite not answered', error);
        });
        return;
      }
      if (
        message?.type === 'sable:call-action' &&
        message.roomId !== undefined &&
        message.userId !== undefined &&
        (message.outcome === 'answer' || message.outcome === 'decline')
      ) {
        const outcome = message.outcome;
        void openFromNotification(
          { userId: message.userId, roomId: message.roomId, eventId: message.eventId ?? null },
          (roomId, eventId) => {
            answerFromNotification(roomId, eventId, outcome);
          }
        ).catch((error: unknown) => {
          console.debug('[sable notifications] call not answered', error);
        });
        return;
      }
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
    const notifiedUser = userId ?? core.session?.user_id;
    if (!notifiedUser) return;
    void openFromNotification({ userId: notifiedUser, roomId, eventId }, openNotification).catch(
      (error: unknown) => {
        console.warn('[sable notifications] notification not opened', error);
      }
    );
  });

  $effect(() => {
    void core.accountRevision;
    if (core.status !== 'ready') return;
    return watchScheduledQueue(core);
  });

  $effect(() => {
    const stop = watchSharedContent(shareInbox);
    if (!('serviceWorker' in navigator)) return stop;

    const off = on(navigator.serviceWorker, 'message', (event) => {
      const workerMessage = event as MessageEvent;
      const message = workerMessage.data as
        | { type?: string; serverUserId?: string | null; text?: string; files?: File[] }
        | undefined;
      if (message?.type === 'sable:server-user') {
        workerMessage.ports[0]?.postMessage(boundServerIdentity());
      } else if (
        message?.type === 'sable:share' &&
        (!import.meta.env.VITE_SABLE_SERVER_URL ||
          (message.serverUserId && message.serverUserId === boundServerIdentity()))
      ) {
        if (!import.meta.env.VITE_SABLE_SERVER_URL) {
          shareInbox.accept(message.text ?? '', message.files ?? []);
        } else {
          void currentServerUser()
            .then((identity) => {
              if (identity === message.serverUserId && identity === boundServerIdentity()) {
                shareInbox.accept(message.text ?? '', message.files ?? []);
              }
            })
            .catch((error: unknown) => {
              console.warn('[sable share] shared content could not be verified', error);
              toasts.error(i18n.t('errors.actionFailed'));
            });
        }
      }
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

    // Restarting these wipes the room list, so a state they read must not rerun this effect.
    untrack(() => {
      void roomList.start().catch((error: unknown) => {
        console.warn('[sable rooms] room list unavailable', error);
      });
      void spaceSidebar.start(core);
      const userId = core.session?.user_id;
      notifications.start(core, (roomId, eventId) => {
        if (!userId) return;
        void openFromNotification({ userId, roomId, eventId }, openNotification).catch(
          (error: unknown) => {
            console.warn('[sable notifications] notification not opened', error);
          }
        );
      });
      presence.start(core);
      dismissedInvites.start(core);
      presenceSharing.start(core);
      presenceOverride.start(core);
      dmSpaces.start(core);
      spaceNotifications.start(core);
      mediaPreviewSettings.start(core);
      profileOverrides.start(core);
      supporter.start(core);
    });
    return () => {
      roomList.stop();
      spaceSidebar.stop();
      notifications.stop();
      presence.stop();
      dismissedInvites.stop();
      presenceSharing.stop();
      presenceOverride.stop();
      dmSpaces.stop();
      spaceNotifications.stop();
      mediaPreviewSettings.stop();
      profileOverrides.stop();
      supporter.stop();
    };
  });

  $effect(() => {
    if (roomList.settled) spaceNotifications.apply(roomList.rooms);
  });

  const LEFT_CONVERSATIONS_SETTLE_MS = 2_000;

  $effect(() => {
    void roomList.rooms;
    if (!roomList.settled) return;
    const timer = setTimeout(() => {
      forgetLeftNativeConversations().catch((error: unknown) => {
        console.debug('[sable notifications] left conversations not forgotten', error);
      });
    }, LEFT_CONVERSATIONS_SETTLE_MS);
    return () => clearTimeout(timer);
  });

  const NOTIFIED_ROOM_WAIT_MS = 10_000;
  const PRESENCE_SETTLE_MS = 2_000;
  const DEVICE_ACTIVITY_INTERVAL_MS = 60_000;
  let deviceActivityWritten = false;

  $effect(() => {
    const accountId = core.session?.account_id;
    if (core.status !== 'ready' || !accountId || !roomList.settled) return;
    const room = roomList.byId(openRoomId);
    if (room?.state === 'joined' && room.room_kind !== 'space' && !room.is_tombstoned) {
      const section = page.url.pathname.startsWith('/home/')
        ? HOME_SECTION
        : (findRoomByPathId(roomList.rooms, page.params.spaceId)?.room_id ?? null);
      rememberLastRoom(accountId, room.room_id, section);
    }
  });

  async function openFromNotification(
    target: NativeNotificationTarget,
    open: NativeNotificationOpen
  ): Promise<void> {
    const opening = await trackNotificationOpening(notificationOpener.open(target, open));
    if (opening === 'unknown_account') toasts.error(i18n.t('nav.notificationAccountMissing'));
    if (opening === 'switch_failed') toasts.error(i18n.t('nav.switchAccountFailed'));
  }

  async function openNotification(
    roomId: string,
    eventId: string | null,
    isCurrent: () => boolean
  ): Promise<void> {
    await tick();
    if (!isCurrent()) return;
    await roomList.start();
    if (!isCurrent()) return;
    await roomList.whenListed(roomId, NOTIFIED_ROOM_WAIT_MS);
    if (!isCurrent()) return;
    if (roomList.rooms.find((room) => room.room_id === roomId)?.state === 'invited') {
      await goto(resolve('/(app)/inbox'));
      return;
    }
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    await goto(roomSectionPath(roomList.rooms, roomId), {
      state: eventId === null ? {} : { notified: eventId },
    });
  }

  $effect(() => {
    if (core.status !== 'ready' || !roomList.settled) return;
    notifications.retireRead(roomList.rooms, roomList.notificationsFor);
  });

  let documentVisible = $derived(windowActivity.visible);
  let active = $derived(windowActivity.active);
  let idle = $derived(windowActivity.idle);
  let quietWhenActiveElsewhere = $derived(preferences.pushInactiveTimeout !== 'off');

  $effect(() => {
    roomList.setPresentationActive(active);
  });

  $effect(() => {
    if (core.status !== 'ready') return;
    notifications.readRoom(active ? openRoomId : null);
  });

  $effect(() => {
    if (core.status !== 'ready' || !alertsNatively()) return;

    const controller = new AbortController();

    for (const watching of [
      watchNativeNotificationActions((action) => {
        const invite = inviteNotificationAction(action);
        if (invite !== null) {
          void answerInvite(action.userId, action.roomId, invite).catch((error: unknown) => {
            console.debug('[sable notifications] invite not answered', error);
          });
          return;
        }
        const call = callNotificationAction(action);
        if (call !== null) {
          void openFromNotification(action, (roomId, eventId) => {
            answerFromNotification(roomId, eventId, call);
          }).catch((error: unknown) => {
            console.debug('[sable notifications] call not answered', error);
          });
          return;
        }
        void performNotificationAction(core, action).catch((error: unknown) => {
          console.debug('[sable notifications] action not performed', error);
        });
      }, controller.signal),
      watchNativeNotificationClicks((target) => {
        void openFromNotification(target, openNotification).catch((error: unknown) => {
          console.warn('[sable notifications] notification not opened', error);
        });
      }, controller.signal),
    ]) {
      void watching.catch((error: unknown) => {
        console.debug('[sable notifications] native listeners not attached', error);
      });
    }

    return () => {
      controller.abort();
      notificationOpener.cancel();
    };
  });

  trackRouteFocus();

  function jumpToRoom(roomId: string): void {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    void goto(roomSectionPath(roomList.rooms, roomId));
  }

  $effect(() => {
    return registerGlobalShortcuts(
      {
        'navigation.openRoomSearch': () => {
          paletteState.open = true;
        },
        'app.searchMessages': () => {
          if (openRoomSearch.run()) return;
          if (page.url.pathname.startsWith(resolve('search'))) {
            document.getElementById(MESSAGE_SEARCH_FIELD_ID)?.focus();
            return;
          }
          // eslint-disable-next-line svelte/no-navigation-without-resolve -- contextSearchPath() resolves the route itself
          void goto(contextSearchPath(roomList.rooms, page.params.roomId, page.params.spaceId));
        },
        'app.openBookmarks': () => {
          void goto(resolve('bookmarks'));
        },
        'app.createRoom': () => {
          const space = findRoomByPathId(roomList.rooms, page.params.spaceId) ?? null;
          void (
            space === null
              ? Promise.resolve(false)
              : core.rpc.members
                  .permissions({ room_id: space.room_id })
                  .then((permissions) => permissions.can_manage_children)
                  .catch(() => false)
          ).then((canAddChildren) => {
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- createRoomPath() resolves the route itself
            void goto(createRoomPath(roomList.rooms, space, canAddChildren));
          });
        },
        'app.showShortcuts': () => {
          shortcutsHelpState.open = true;
        },
        'call.toggleMute': (event) => {
          if (event.repeat || callSession.desktopShortcutStatus === 'portal') return;
          if (callSession.active && callSession.mediaReady) {
            void callSession.toggleMicrophone();
          }
        },
        'call.pushToTalk': {
          press: () => {
            void callSession.setTalking(true);
          },
          release: () => {
            void callSession.setTalking(false);
          },
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
            void callSession.toggleScreenShare();
          }
        },
        'call.hangUp': () => {
          if (callSession.active) void callSession.leave();
        },
        'app.openSettings': () => {
          if (appLayout.current) showSettingsOver(defaultSettingsSection());
          else void goto(resolve('/(app)/settings'));
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
          markRoomsRead([room], core.rpc.timeline);
        },
        'room.markAllRead': () => {
          markRoomsRead(roomList.rooms, core.rpc.timeline);
        },
        'room.close': () => {
          if (openRoomId) backToRoomList();
        },
        'navigation.nextUnread': () => {
          const unread = unreadRoomsByPriority(roomList.rooms, openRoomId, roomList.unreadFor);
          const target = unread[0];
          if (!target) return;
          jumpToRoom(target.room_id);
        },
        'navigation.cycleNextUnread': () => {
          const target = unreadRoomAtOffset(roomList.rooms, openRoomId, 1, roomList.unreadFor);
          if (target) jumpToRoom(target.room_id);
        },
        'navigation.focusComposer': () => {
          focusRegion('composer');
        },
        'navigation.focusTimeline': () => {
          focusRegion('timeline');
        },
        'navigation.focusRoomList': () => {
          focusRegion('rooms');
        },
        'navigation.focusSpaces': () => {
          focusRegion('spaces');
        },
        'navigation.nextRegion': () => {
          cycleRegion(1);
        },
        'navigation.previousRegion': () => {
          cycleRegion(-1);
        },
        'navigation.cyclePreviousUnread': () => {
          const target = unreadRoomAtOffset(roomList.rooms, openRoomId, -1, roomList.unreadFor);
          if (target) jumpToRoom(target.room_id);
        },
      },
      (shortcut) => shortcut.category !== 'call' || callSession.active
    );
  });
</script>

<svelte:document onclick={onClick} onauxclick={onClick} />

{#if core.status === 'ready'}
  {#key core.accountRevision}
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <AppShell>
      {#if !previousAccountRoute}
        {@render children()}
      {/if}
    </AppShell>
    <MediaViewerHost />
    {#if preferences.callScreenPreview && callSession.active && callSession.views === 0 && callSession.rooms.length > 0}
      {#await import('#lib/features/call/ScreenSharePreview.svelte') then { default: ScreenSharePreview }}
        <ScreenSharePreview
          session={callSession}
          onReturn={() => {
            if (callSession.roomId !== null) {
              // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
              void goto(roomSectionPath(roomList.rooms, callSession.roomId));
            }
          }}
        />
      {/await}
    {/if}
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
    {:else if callSession.mediaReady}
      {#await import('#lib/features/call/NativeCallAudio.svelte') then { default: NativeCallAudio }}
        <NativeCallAudio
          participants={callSession.transport.participants}
          deafened={callSession.deafened}
          volumeOf={callVolumeOf}
          setVolume={(identity, volume, screen) =>
            callSession.setParticipantVolume(identity, volume, screen)}
        />
      {/await}
    {/if}
    {#if screenSharePick}
      {@const pick = screenSharePick}
      {#await import('#lib/features/call/ScreenSharePickerDialog.svelte') then { default: ScreenSharePickerDialog }}
        <ScreenSharePickerDialog
          sources={pick.sources}
          onShare={(id) => {
            pick.settle(id);
          }}
          onCancel={() => {
            pick.settle(null);
          }}
        />
      {/await}
    {/if}
    {#if callSession.choosingScreenAudio}
      {#await import('#lib/features/call/ScreenShareAudioDialog.svelte') then { default: ScreenShareAudioDialog }}
        <ScreenShareAudioDialog
          onShare={(choice) => void callSession.shareScreenWith(choice)}
          onCancel={() => {
            callSession.choosingScreenAudio = false;
          }}
        />
      {/await}
    {/if}
    <IncomingCallDialog
      call={incoming}
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
    <CommandPalette bind:open={paletteState.open} />
    <ShortcutsHelpDialog bind:open={shortcutsHelpState.open} />
    <ShareTargetSheet inbox={shareInbox} />
    <ToastRegion dismissLabel={i18n.t('common.dismiss')} />
  {/key}
{:else if core.status === 'error'}
  <main class="app-status" aria-labelledby="app-status-title">
    <div class="app-status-card" role="alert">
      <h1 id="app-status-title">{i18n.t('app.unableToStart')}</h1>
      <p>{i18n.t('app.startFailed')}</p>
      <Button onclick={() => void core.start()}>{i18n.t('common.tryAgain')}</Button>
    </div>
  </main>
{:else}
  <main class="app-status" aria-labelledby="app-status-title" aria-busy="true">
    <div class="app-status-card" role="status">
      <Spinner />
      <h1 id="app-status-title">
        {loadingAnimal
          ? i18n.t('app.pettingAnimal', { animal: loadingAnimal })
          : i18n.t('common.startingSable')}
      </h1>
      {#if core.slowStart}
        <p>{i18n.t('app.startSlow')}</p>
        <Button onclick={() => void core.retryStart()}>{i18n.t('common.tryAgain')}</Button>
      {/if}
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
    color: var(--surface-on-container);
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
    color: var(--bg-on-container);
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
