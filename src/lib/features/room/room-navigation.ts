import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
import { resolve } from '$app/paths';
import { page } from '$app/state';

import type { RoomListItemView } from '#src/generated/protocol';

import {
  findRoomByPathId,
  roomPathParam,
  roomPathParamFromId,
} from '#lib/rooms/room-list.svelte.js';
import { isEditableTarget } from '#lib/ui/shortcuts/binding.js';
import { matchesAppLayout } from '#lib/ui/app-layout.svelte.js';
import { focusRegion } from '#lib/ui/shortcuts/focus-regions.js';

let enteredFrom: string | null = null;

export function trackRoomEntry(): void {
  afterNavigate((navigation) => {
    const wentBack = navigation.type === 'popstate' && navigation.delta < 0;
    enteredFrom = wentBack ? null : (navigation.from?.url.pathname ?? null);
  });
}

function roomListPath(): string {
  if (page.url.pathname.startsWith('/home/')) return resolve('/(app)/home');
  if (page.url.pathname.startsWith('/direct/')) return resolve('direct');
  if (page.url.pathname.startsWith('/space/') && page.params.spaceId) {
    const spaceId = roomPathParamFromId(page.params.spaceId);
    return matchesAppLayout()
      ? resolve('/(app)/space/[spaceId]/lobby', { spaceId })
      : resolve('/(app)/space/[spaceId]', { spaceId });
  }
  return resolve('/(app)/rooms');
}

export async function leaveRoomView(): Promise<void> {
  await afterOverlayPops();
  const target = roomListPath();
  if (enteredFrom === target) {
    enteredFrom = null;
    history.back();
    return;
  }
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomListPath() resolves the route itself
  await goto(target);
}

export function backToRoomList(): void {
  if (matchesAppLayout()) {
    void leaveRoomView();
    return;
  }
  setMobileDrawerOpen(true);
}

export function setMobileDrawerOpen(open: boolean): void {
  if (open && page.state.mobileDrawerBack && page.state.mobileDrawer !== 'open') {
    history.back();
    return;
  }
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- shallow state on the current URL
  void goto('', {
    shallow: true,
    replace: open,
    state: { ...page.state, mobileDrawer: open ? 'open' : 'closed', mobileDrawerBack: !open },
    persistState: true,
  });
}

const TREE_REGIONS = '[data-focus-region="rooms"], [data-focus-region="spaces"]';

const ROOM_PATH =
  /^\/(?:(?:home|rooms|direct)\/[^/]+|space\/[^/]+\/(?!lobby$|create-room$|create-space$)[^/]+)$/;

const COMPOSER_REGION = '[data-focus-region="composer"]';
const HEADING_ATTEMPTS = 10;

export function trackRouteFocus(): void {
  let origin: Element | null = null;
  let composerObserver: MutationObserver | undefined;
  beforeNavigate(() => {
    composerObserver?.disconnect();
    origin = document.activeElement;
  });
  afterNavigate((navigation) => {
    const from = origin;
    origin = null;
    if (from?.isConnected && from.closest(TREE_REGIONS)) {
      if (navigation.to && ROOM_PATH.test(navigation.to.url.pathname) && matchesAppLayout()) {
        const focusComposer = () => {
          if (
            (document.activeElement !== document.body && document.activeElement !== from) ||
            focusRegion('composer')
          ) {
            composerObserver?.disconnect();
            return true;
          }
          return false;
        };
        if (!focusComposer()) {
          composerObserver = new MutationObserver(focusComposer);
          composerObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['contenteditable'],
          });
        }
        return;
      }
      if (document.activeElement === document.body && from instanceof HTMLElement) from.focus();
      return;
    }
    if (
      from instanceof HTMLElement &&
      !from.closest('[role="dialog"]') &&
      (isEditableTarget(from) || from.closest(COMPOSER_REGION))
    ) {
      return;
    }
    if (!navigation.to || !ROOM_PATH.test(navigation.to.url.pathname)) return;
    let attempts = HEADING_ATTEMPTS;
    const focusHeading = () => {
      if (document.activeElement !== document.body) return;
      const heading = document.querySelector<HTMLElement>('[data-room-heading]');
      if (heading) heading.focus({ preventScroll: true });
      else if (--attempts > 0) requestAnimationFrame(focusHeading);
    };
    focusHeading();
  });
}

export function isRoomSwitch(href: string): boolean {
  const target = new URL(href, page.url.href).pathname;
  return (
    page.params.roomId !== undefined &&
    target !== page.url.pathname &&
    ROOM_PATH.test(target) &&
    !matchesAppLayout()
  );
}

export function goToPage(href: string): void {
  const target = new URL(href, page.url.href).pathname;
  const mobile = !matchesAppLayout();
  if (target === page.url.pathname && mobile) {
    setMobileDrawerOpen(false);
    return;
  }
  const roomSwitch = isRoomSwitch(href);
  const fromList =
    page.state.mobileDrawer === 'open' ||
    /^\/(?:home|rooms|direct|space\/[^/]+)$/.test(page.url.pathname);
  if (roomSwitch || (mobile && ROOM_PATH.test(target) && fromList)) {
    // The list entry must hold the open room, or Back reloads the previous one under the drawer.
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolved href
    void goto(href, {
      replace: roomSwitch,
      state: { mobileDrawer: 'open' },
      persistState: true,
    }).then(() => {
      if (page.url.pathname === target) setMobileDrawerOpen(false);
    });
    return;
  }
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolved href
  void goto(href, { replace: false, state: {}, persistState: true });
}

export function scopedSearchQuery(
  operator: 'in' | 'space',
  room: RoomListItemView | undefined,
  roomId: string
): string {
  const label = room?.canonical_alias ?? room?.name ?? roomId;
  const scope = label.includes(' ') ? `"${label}"` : label;
  return `${operator}:${scope} `;
}

export function scopedSearchPath(
  operator: 'in' | 'space',
  room: RoomListItemView | undefined,
  roomId: string
): string {
  return `${resolve('/(app)/search')}?q=${encodeURIComponent(scopedSearchQuery(operator, room, roomId))}`;
}

export function contextSearchPath(
  rooms: readonly RoomListItemView[],
  roomPathId: string | undefined,
  spacePathId: string | undefined
): string {
  const room = findRoomByPathId(rooms, roomPathId);
  if (room) return scopedSearchPath('in', room, room.room_id);
  const space = findRoomByPathId(rooms, spacePathId);
  if (space) return scopedSearchPath('space', space, space.room_id);
  return resolve('/(app)/search');
}

export function searchInRoom(room: RoomListItemView | undefined, roomId: string): void {
  const target = scopedSearchPath('in', room, roomId);

  // eslint-disable-next-line svelte/no-navigation-without-resolve -- scopedSearchPath() resolves the route itself
  goto(target).catch((error: unknown) => {
    console.debug('[sable room] search navigation failed', error);
  });
}

export function createRoomPath(
  rooms: readonly RoomListItemView[],
  space: RoomListItemView | null,
  canAddChildren: boolean
): string {
  return space === null || !canAddChildren
    ? resolve('create-room')
    : resolve('/(app)/space/[spaceId]/create-room', { spaceId: roomPathParam(space, rooms) });
}
