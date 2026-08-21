<script lang="ts">
  import type { Component } from 'svelte';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { resolve } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParam } from '#lib/rooms/room-list.svelte.js';
  import { saveSpacePath, savedSpacePaths, spaceNavigationHref } from './space-paths.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  /** `href` is resolved where the item is built, so templates use it as-is. */
  type RailItem = {
    href: string;
    activePrefix: string;
    label: string;
    icon?: Component;
    initial?: string;
    avatar?: string | null;
    navigateHref?: string;
    unread?: boolean;
    unreadCount?: number;
  };

  interface Props {
    spaces: readonly RoomSummary[];
    unreadSpaceIds?: ReadonlySet<string>;
    homeUnread?: number;
    homeHighlight?: boolean;
    directRooms?: readonly RoomSummary[];
    directUnread?: number;
    mobile?: boolean;
    onNavigate?: (href: string) => void;
  }

  let {
    spaces,
    unreadSpaceIds = new Set(),
    homeUnread = 0,
    homeHighlight = false,
    directRooms = [],
    directUnread = 0,
    mobile = false,
    onNavigate,
  }: Props = $props();
  let spacePaths = $state(savedSpacePaths());

  let items = $derived<readonly RailItem[]>([
    {
      href: resolve('home'),
      activePrefix: '/home',
      icon: HouseIcon,
      label: 'nav.home',
      unread: homeUnread > 0,
      unreadCount: homeHighlight ? homeUnread : undefined,
    },
    {
      href: resolve('navigate'),
      activePrefix: '/navigate',
      icon: MagnifyingGlassIcon,
      label: 'nav.navigate',
    },
    {
      href: resolve('direct'),
      activePrefix: '/direct',
      icon: ChatsIcon,
      label: 'nav.direct',
      unreadCount: directUnread,
    },
  ]);

  let spaceItems = $derived<RailItem[]>(
    spaces.map((space) => {
      const name = spaceName(space.name, space.room_id);
      const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(space) });
      const savedPath = spacePaths[space.room_id];
      const navigateHref = spaceNavigationHref(href, savedPath, mobile);

      return {
        href,
        activePrefix: href,
        navigateHref,
        initial: initial(name),
        avatar: space.avatar_url,
        label: name,
        unread: unreadSpaceIds.has(space.room_id),
      };
    })
  );
  let directItems = $derived<RailItem[]>(
    directRooms.map((room) => {
      const name = spaceName(room.name, room.room_id);
      const href = resolve('/(app)/direct/[roomId]', { roomId: roomPathParam(room) });
      const unread = room.highlight || room.unread;

      return {
        href,
        activePrefix: href,
        initial: initial(name),
        avatar: room.avatar_url,
        label: name,
        unreadCount: unread,
      };
    })
  );

  const createItem: RailItem = {
    href: resolve('create-room'),
    activePrefix: '/create-room',
    icon: PlusIcon,
    label: 'nav.createRoom',
  };

  function spaceName(name: string | null, roomId: string): string {
    return name ?? roomId;
  }

  function initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  function isActive(item: RailItem): boolean {
    if (item.initial) {
      return (
        page.url.pathname.startsWith(`${item.activePrefix}/`) ||
        page.url.pathname === item.activePrefix
      );
    }

    return page.url.pathname.startsWith(item.activePrefix);
  }

  function navigate(item: RailItem): void {
    onNavigate?.(item.navigateHref ?? item.href);
  }

  afterNavigate(() => {
    if (mobile) return;

    const path = `${page.url.pathname}${page.url.search}${page.url.hash}`;
    const space = spaces.find((candidate) => {
      const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(candidate) });
      return path === href || path.startsWith(`${href}/`);
    });
    if (!space || spacePaths[space.room_id] === path) return;

    spacePaths = { ...spacePaths, [space.room_id]: path };
    saveSpacePath(space.room_id, path);
  });
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- every rail href is
     built with resolve() above; resolving again here would double the base path -->
{#if mobile}
  <div class="rail">
    <div class="rail-scroll">
      <ul class="rail-stack">
        {#each [...items, ...directItems, ...spaceItems] as item (item.href)}
          {@const active = isActive(item)}
          <li>
            <a
              class="rail-item sable-selection-layer"
              class:space-item={Boolean(item.initial)}
              class:active
              href={item.navigateHref ?? item.href}
              onclick={() => {
                navigate(item);
              }}
              aria-label={$i18n.t(item.label)}
              aria-current={active ? 'page' : undefined}
            >
              {#if item.icon}
                <span class="icon" aria-hidden="true"
                  ><item.icon weight={active ? 'fill' : 'regular'} /></span
                >
              {:else}
                <Avatar
                  class="space-initial"
                  src={item.avatar}
                  initials={item.initial}
                  size="small"
                />
              {/if}
              {#if item.unreadCount}
                <span class="unread-count" aria-hidden="true">{item.unreadCount}</span>
              {:else if item.unread}
                <span class="unread-dot" aria-hidden="true"></span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
      <div class="dynamic-rail-region" aria-hidden="true"></div>
    </div>
    <ul class="rail-stack rail-bottom">
      <li>
        <a
          class="rail-item sable-selection-layer"
          class:active={isActive(createItem)}
          href={createItem.href}
          onclick={() => {
            navigate(createItem);
          }}
          aria-label={$i18n.t(createItem.label)}
          aria-current={isActive(createItem) ? 'page' : undefined}
        >
          <span class="icon" aria-hidden="true"
            ><PlusIcon weight={isActive(createItem) ? 'fill' : 'regular'} /></span
          >
        </a>
      </li>
    </ul>
  </div>
{:else}
  <div class="rail">
    <div class="rail-scroll">
      <ul class="rail-stack">
        {#each [...items, ...directItems, ...spaceItems] as item (item.href)}
          {@const active = isActive(item)}
          {@const label = $i18n.t(item.label)}
          <li>
            {#snippet trigger({ props }: { props: Record<string, unknown> })}
              <a
                {...props}
                class="rail-item sable-selection-layer"
                class:space-item={Boolean(item.initial)}
                class:active
                href={item.navigateHref ?? item.href}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
              >
                {#if item.icon}
                  <span class="icon" aria-hidden="true"
                    ><item.icon weight={active ? 'fill' : 'regular'} /></span
                  >
                {:else}
                  <Avatar
                    class="space-initial"
                    src={item.avatar}
                    initials={item.initial}
                    size="small"
                  />
                {/if}
                {#if item.unreadCount}
                  <span class="unread-count" aria-hidden="true">{item.unreadCount}</span>
                {:else if item.unread}
                  <span class="unread-dot" aria-hidden="true"></span>
                {/if}
              </a>
            {/snippet}
            <Tooltip {label} side="right" {trigger} />
          </li>
        {/each}
      </ul>
      <div class="dynamic-rail-region" aria-hidden="true"></div>
    </div>
    <ul class="rail-stack rail-bottom">
      <li>
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          {@const label = $i18n.t(createItem.label)}
          <a
            {...props}
            class="rail-item sable-selection-layer"
            class:active={isActive(createItem)}
            href={createItem.href}
            aria-label={label}
            aria-current={isActive(createItem) ? 'page' : undefined}
          >
            <span class="icon" aria-hidden="true"
              ><PlusIcon weight={isActive(createItem) ? 'fill' : 'regular'} /></span
            >
          </a>
        {/snippet}

        <Tooltip label={$i18n.t(createItem.label)} side="right" {trigger} />
      </li>
    </ul>
  </div>
{/if}

<style>
  .rail {
    background: var(--sable-bg-container);
    border-right: var(--border-width) solid var(--sable-bg-container-line);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 0 0 var(--navigation-rail-width);
    flex-direction: column;
    min-height: 0;
    width: var(--navigation-rail-width);
  }

  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow: hidden auto;
  }

  .dynamic-rail-region {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
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
    display: none;
    height: 1rem;
    left: -0.75rem;
    position: absolute;
    transform: translateX(-50%);
    width: 3px;
  }

  .rail-item:hover::before {
    display: block;
  }

  .rail-item.active::before {
    display: block;
    height: 1.5rem;
  }

  @media (hover: hover) and (pointer: fine) {
    .rail-item:hover {
      background: var(--sable-bg-container-hover);
      transform: translateX(0.125rem);
    }
  }

  .rail-item.active {
    color: var(--sable-bg-on-container);
  }

  .icon {
    display: flex;
  }

  .unread-dot {
    background: var(--sable-primary-main);
    border: calc(var(--border-width) * 2) solid var(--sable-bg-container);
    border-radius: 50%;
    box-sizing: border-box;
    height: 0.625rem;
    position: absolute;
    right: 0.125rem;
    top: 0.125rem;
    width: 0.625rem;
  }

  .unread-count {
    align-items: center;
    background: var(--sable-primary-main);
    border: calc(var(--border-width) * 2) solid var(--sable-bg-container);
    border-radius: var(--radius-pill);
    box-sizing: border-box;
    color: var(--sable-primary-on-main);
    display: flex;
    font-size: 0.625rem;
    font-weight: var(--font-weight-bold);
    justify-content: center;
    line-height: 1;
    min-width: 1.125rem;
    padding: 0 0.1875rem;
    position: absolute;
    right: -0.125rem;
    top: -0.125rem;
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .rail-item:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (prefers-reduced-motion: no-preference) {
    .rail-item {
      transition:
        border-color var(--motion-normal) var(--motion-easing-standard),
        color var(--motion-normal) var(--motion-easing-standard),
        transform var(--motion-slow) cubic-bezier(0, 0.8, 0.67, 0.97);
    }
  }
</style>
