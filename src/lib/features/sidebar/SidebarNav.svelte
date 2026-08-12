<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import { roomPathParam, useRoomList } from '$lib/rooms/room-list.svelte';
  import { Tooltip } from 'bits-ui';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import RoomNav from './RoomNav.svelte';
  import UserQuickTools from './UserQuickTools.svelte';

  const items = [
    { href: '/home', icon: HouseIcon, label: 'nav.home' },
    { href: '/navigate', icon: MagnifyingGlassIcon, label: 'nav.navigate' },
    { href: '/direct', icon: ChatsIcon, label: 'nav.direct' },
  ] as const;
  const createItem = { href: '/create-room', icon: PlusIcon, label: 'nav.createRoom' } as const;

  interface Props {
    mobile?: boolean;
    onNavigate?: (href: string) => void;
    roomNavWidth?: number;
  }

  const MIN_ROOM_NAV_WIDTH = 50;
  const COLLAPSED_ROOM_NAV_WIDTH = 190;
  const MAX_ROOM_NAV_WIDTH = 500;
  const ROOM_NAV_WIDTH_STEP = 80;

  let { mobile = false, onNavigate, roomNavWidth = $bindable(224) }: Props = $props();
  const roomList = useRoomList();
  let dragging = $state(false);
  let drag: { pointerId: number; startX: number; startWidth: number } | undefined;
  let collapsed = $derived(roomNavWidth < COLLAPSED_ROOM_NAV_WIDTH);
  let spaces = $derived.by(() => {
    const childSpaceIds = roomList.rooms
      .filter((room) => room.is_space)
      .flatMap((space) => space.space_children.map((child) => child.room_id));

    return roomList.rooms.filter((room) => room.is_space && !childSpaceIds.includes(room.room_id));
  });

  function clampRoomNavWidth(width: number) {
    const clamped = Math.max(MIN_ROOM_NAV_WIDTH, Math.min(MAX_ROOM_NAV_WIDTH, width));

    if (clamped > MIN_ROOM_NAV_WIDTH && clamped < COLLAPSED_ROOM_NAV_WIDTH) {
      return clamped - MIN_ROOM_NAV_WIDTH < COLLAPSED_ROOM_NAV_WIDTH - clamped
        ? MIN_ROOM_NAV_WIDTH
        : COLLAPSED_ROOM_NAV_WIDTH;
    }

    return clamped;
  }

  function handleResizeStart(event: PointerEvent) {
    if (event.button !== 0) return;

    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;

    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: roomNavWidth };
    dragging = true;
    handle.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    roomNavWidth = clampRoomNavWidth(drag.startWidth + event.clientX - drag.startX);
  }

  function finishResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    drag = undefined;
    dragging = false;
  }

  function handleResizeKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    roomNavWidth = clampRoomNavWidth(
      roomNavWidth + (event.key === 'ArrowLeft' ? -ROOM_NAV_WIDTH_STEP : ROOM_NAV_WIDTH_STEP)
    );
  }

  function spaceName(name: string | null, roomId: string) {
    return name ?? roomId;
  }

  function initial(name: string) {
    return name.slice(0, 1).toUpperCase();
  }
</script>

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="navigation-main">
        <div class="rail">
          <div class="rail-scroll">
            <ul class="rail-stack">
              {#each items as item (item.href)}
                {@const active = page.url.pathname.startsWith(item.href)}
                <li>
                  <a
                    class="rail-item"
                    class:active
                    href={resolve(item.href)}
                    onclick={() => onNavigate?.(item.href)}
                    aria-label={$i18n.t(item.label)}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span class="icon" aria-hidden="true"><item.icon /></span>
                  </a>
                </li>
              {/each}
              {#each spaces as space (space.room_id)}
                {@const name = spaceName(space.name, space.room_id)}
                {@const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(space) })}
                {@const active =
                  page.url.pathname.startsWith(`${href}/`) || page.url.pathname === href}
                <li>
                  <a
                    class="rail-item space-item"
                    class:active
                    {href}
                    onclick={() => onNavigate?.(href)}
                    aria-label={name}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span class="space-initial" aria-hidden="true">{initial(name)}</span>
                  </a>
                </li>
              {/each}
            </ul>
            <div class="dynamic-rail-region" aria-hidden="true"></div>
          </div>
          <ul class="rail-stack rail-bottom">
            <li>
              <a
                class="rail-item"
                href={resolve(createItem.href)}
                onclick={() => onNavigate?.(createItem.href)}
                aria-label={$i18n.t(createItem.label)}
              >
                <span class="icon" aria-hidden="true"><createItem.icon /></span>
              </a>
            </li>
          </ul>
        </div>
        <RoomNav {onNavigate} />
      </div>
      <UserQuickTools mobile {onNavigate} />
    </nav>
  {:else}
    <Tooltip.Provider>
      <nav class="desktop-navigation" aria-label={$i18n.t('nav.primary')}>
        <div class="desktop-navigation-main">
          <div class="rail">
            <div class="rail-scroll">
              <ul class="rail-stack">
                {#each items as item (item.href)}
                  {@const active = page.url.pathname.startsWith(item.href)}
                  <li>
                    {#snippet trigger({ props }: { props: Record<string, unknown> })}
                      <a
                        {...props}
                        class="rail-item"
                        class:active
                        href={resolve(item.href)}
                        aria-label={$i18n.t(item.label)}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span class="icon" aria-hidden="true"><item.icon /></span>
                      </a>
                    {/snippet}
                    <Tooltip.Root>
                      <Tooltip.Trigger child={trigger} />
                      <Tooltip.Content class="rail-tooltip" side="right" sideOffset={8}
                        >{$i18n.t(item.label)}</Tooltip.Content
                      >
                    </Tooltip.Root>
                  </li>
                {/each}
                {#each spaces as space (space.room_id)}
                  {@const name = spaceName(space.name, space.room_id)}
                  {@const href = resolve('/(app)/space/[spaceId]', {
                    spaceId: roomPathParam(space),
                  })}
                  {@const active =
                    page.url.pathname.startsWith(`${href}/`) || page.url.pathname === href}
                  <li>
                    {#snippet trigger({ props }: { props: Record<string, unknown> })}
                      <a
                        {...props}
                        class="rail-item space-item"
                        class:active
                        {href}
                        aria-label={name}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span class="space-initial" aria-hidden="true">{initial(name)}</span>
                      </a>
                    {/snippet}
                    <Tooltip.Root>
                      <Tooltip.Trigger child={trigger} />
                      <Tooltip.Content class="rail-tooltip" side="right" sideOffset={8}
                        >{name}</Tooltip.Content
                      >
                    </Tooltip.Root>
                  </li>
                {/each}
              </ul>
              <div class="dynamic-rail-region" aria-hidden="true"></div>
            </div>
            <ul class="rail-stack rail-bottom">
              <li>
                {#snippet trigger({ props }: { props: Record<string, unknown> })}
                  <a
                    {...props}
                    class="rail-item"
                    href={resolve(createItem.href)}
                    aria-label={$i18n.t(createItem.label)}
                  >
                    <span class="icon" aria-hidden="true"><createItem.icon /></span>
                  </a>
                {/snippet}
                <Tooltip.Root>
                  <Tooltip.Trigger child={trigger} />
                  <Tooltip.Content class="rail-tooltip" side="right" sideOffset={8}
                    >{$i18n.t(createItem.label)}</Tooltip.Content
                  >
                </Tooltip.Root>
              </li>
            </ul>
          </div>
          <RoomNav width={roomNavWidth} {collapsed} />
          <button
            type="button"
            class="resize-handle"
            class:dragging
            aria-label={$i18n.t('nav.resizeRooms')}
            onpointerdown={handleResizeStart}
            onpointermove={handleResizeMove}
            onpointerup={finishResize}
            onpointercancel={finishResize}
            onkeydown={handleResizeKeydown}
          ></button>
        </div>
        {#if collapsed}
          <UserQuickTools compact />
        {:else}
          <UserQuickTools />
        {/if}
      </nav>
    </Tooltip.Provider>
  {/if}
</aside>

<style>
  .desktop-navigation {
    display: none;
    flex-direction: column;
  }

  .desktop-navigation-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .mobile-navigation,
  .desktop-navigation {
    height: 100%;
    min-height: 0;
  }

  .mobile-navigation {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .navigation-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .rail {
    background: var(--sable-bg-container);
    border-right: 1px solid var(--sable-bg-container-line);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 0 0 4.125rem;
    flex-direction: column;
    min-height: 0;
    width: 4.125rem;
  }

  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .dynamic-rail-region {
    border-top: 1px solid var(--sable-bg-container-line);
    margin: 0.25rem auto;
    width: 2rem;
  }

  .rail-stack {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
  }

  .rail-bottom {
    gap: 0.5rem;
    padding: 0.5rem 0 0.75rem;
  }

  .rail-item {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    height: 2.625rem;
    justify-content: center;
    position: relative;
    width: 2.625rem;
  }

  .rail-item::before {
    background: currentcolor;
    border-radius: 0 0.25rem 0.25rem 0;
    content: '';
    height: 1.5rem;
    left: -0.75rem;
    position: absolute;
    transform: translateX(-50%);
    width: 3px;
  }

  .rail-item:not(.active)::before {
    display: none;
  }

  .rail-item:hover {
    background: var(--sable-bg-container-hover);
  }

  .rail-item.active {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
  }

  .icon {
    display: flex;
  }

  .space-initial {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.5rem;
    justify-content: center;
    width: 1.5rem;
  }

  .icon :global(svg) {
    height: 1.375rem;
    width: 1.375rem;
  }

  .rail-tooltip {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    color: var(--sable-bg-on-container);
    padding: 0.375rem 0.625rem;
  }

  .rail-item:focus-visible {
    outline: 3px solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .rail-item {
      transition:
        background-color var(--motion-normal) ease,
        transform var(--motion-slow) cubic-bezier(0, 0.8, 0.67, 0.97);
    }

    .rail-item:hover {
      transform: translateX(0.125rem);
    }
  }

  @media (width >= 48rem) {
    .sidebar {
      height: 100dvh;
      left: 0;
      position: fixed;
      top: 0;
      width: calc(4.125rem + var(--room-nav-width));
      z-index: 1;
    }

    .desktop-navigation {
      display: flex;
    }

    .resize-handle {
      appearance: none;
      background: transparent;
      border: 0;
      cursor: col-resize;
      height: 100%;
      padding: 0;
      position: absolute;
      right: -0.25rem;
      top: 0;
      touch-action: none;
      user-select: none;
      width: 0.5rem;
    }

    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--sable-primary-main);
    }

    .resize-handle:focus-visible {
      outline: 3px solid var(--sable-focus-ring);
      outline-offset: -3px;
    }
  }

  @media (width < 48rem) {
    .sidebar {
      height: 100%;
      width: 100%;
    }
  }
</style>
