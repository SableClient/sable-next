import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
import { setPageState } from '#lib/platform/page-state.js';
import { resolve } from '$app/paths';
import { page } from '$app/state';

import type { RoomListItemView } from '#src/generated/protocol';

import { findRoomByPathId, roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
import { isEditableTarget } from '#lib/ui/shortcuts/binding.js';
import { matchesAppLayout } from '#lib/ui/app-layout.svelte.js';

let enteredFrom: string | null = null;

export function trackRoomEntry(): void {
  afterNavigate((navigation) => {
    const wentBack = navigation.type === 'popstate' && navigation.delta < 0;
    enteredFrom = wentBack ? null : (navigation.from?.url.pathname ?? null);
  });
}

function roomListPath(): string {
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
  void setPageState({ ...page.state, mobileDrawer: 'open' }, true);
}

const TREE_REGIONS = '[data-focus-region="rooms"], [data-focus-region="spaces"]';

const ROOM_PATH =
  /^\/(?:(?:rooms|direct)\/[^/]+|space\/[^/]+\/(?!lobby$|create-room$|create-space$)[^/]+)$/;

const COMPOSER_REGION = '[data-focus-region="composer"]';
const HEADING_ATTEMPTS = 10;

export function trackRouteFocus(): void {
  let origin: Element | null = null;
  beforeNavigate(() => {
    origin = document.activeElement;
  });
  afterNavigate((navigation) => {
    const from = origin;
    origin = null;
    if (from?.isConnected && from.closest(TREE_REGIONS)) {
      if (document.activeElement === document.body && from instanceof HTMLElement) from.focus();
      return;
    }
    if (from instanceof HTMLElement && (isEditableTarget(from) || from.closest(COMPOSER_REGION))) {
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
  const samePage = new URL(href, page.url.href).pathname === page.url.pathname;
  if (samePage && !matchesAppLayout()) {
    void setPageState({ ...page.state, mobileDrawer: 'closed' }, true);
    return;
  }
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolved href
  void goto(href, { replace: isRoomSwitch(href) });
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
