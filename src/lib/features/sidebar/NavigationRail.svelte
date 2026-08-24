<script lang="ts">
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import RoomSettingsDialog from '#lib/features/room/RoomSettingsDialog.svelte';

  import RoomOptionsMenu from './RoomOptionsMenu.svelte';
  import type { Component } from 'svelte';
  import { ContextMenu } from 'bits-ui';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { resolve } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParam } from '#lib/rooms/room-list.svelte.js';
  import {
    folderName,
    mergeSpaces,
    refsEqual,
    type DropInstruction,
    type LayoutRef,
    type SidebarFolder,
    type SidebarItem,
  } from '#lib/spaces/sidebar-layout.js';
  import { saveSpacePath, savedSpacePaths, spaceNavigationHref } from './space-paths.js';
  import { createDragList, type DropState } from '#lib/ui/drag-list.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import ArrowLineUpIcon from 'phosphor-svelte/lib/ArrowLineUpIcon';
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpenIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

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
    unspacedUnread?: number;
    unspacedHighlight?: boolean;
    directRooms?: readonly RoomSummary[];
    directUnread?: number;
    mobile?: boolean;
    onNavigate?: (href: string) => void;
    layout?: readonly SidebarItem[];
    openFolders?: ReadonlySet<string>;
    onToggleFolder?: (folderId: string) => void;
    onRenameFolder?: (folder: SidebarFolder) => void;
    onUngroupFolder?: (folderId: string) => void;
    onRemoveFromFolder?: (roomId: string, folderId: string) => void;
    onReorder?: (source: LayoutRef, target: LayoutRef, instruction: DropInstruction) => void;
  }

  let {
    spaces,
    unreadSpaceIds = new Set(),
    homeUnread = 0,
    homeHighlight = false,
    unspacedUnread = 0,
    unspacedHighlight = false,
    directRooms = [],
    directUnread = 0,
    mobile = false,
    onNavigate,
    layout = [],
    openFolders = new Set(),
    onToggleFolder,
    onRenameFolder,
    onUngroupFolder,
    onRemoveFromFolder,
    onReorder,
  }: Props = $props();
  let spacePaths = $state(savedSpacePaths());
  let dragged = $state<LayoutRef | null>(null);
  let dropState = $state<DropState<LayoutRef> | null>(null);

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
      href: resolve('/(app)/rooms'),
      activePrefix: '/rooms',
      icon: HashIcon,
      label: 'nav.unspaced',
      unread: unspacedUnread > 0,
      unreadCount: unspacedHighlight ? unspacedUnread : undefined,
    },
    {
      href: resolve('/(app)/search'),
      activePrefix: '/search',
      icon: MagnifyingGlassIcon,
      label: 'search.title',
    },
    {
      href: resolve('direct'),
      activePrefix: '/direct',
      icon: ChatsIcon,
      label: 'nav.direct',
      unreadCount: directUnread,
    },
  ]);

  let spacesById = $derived(new Map(spaces.map((space) => [space.room_id, space])));
  let entries = $derived(
    mergeSpaces(
      layout,
      spaces.map((space) => space.room_id)
    )
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

  let contextSpace = $state<RoomSummary | null>(null);
  let contextAnchor = $state<HTMLElement | null>(null);
  let contextOpen = $state(false);
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);

  let settingsRoom = $derived(spaces.find((space) => space.room_id === settingsRoomId) ?? null);
  let leaveRoom = $derived(spaces.find((space) => space.room_id === leaveRoomId) ?? null);

  function openSpaceContextMenu(event: MouseEvent, roomId: string): void {
    const space = spacesById.get(roomId);
    const target = event.currentTarget;
    if (space === undefined || !(target instanceof HTMLElement)) return;
    event.preventDefault();
    contextSpace = space;
    contextAnchor = target;
    contextOpen = true;
  }

  function spaceItem(roomId: string): RailItem | null {
    const space = spacesById.get(roomId);
    if (space === undefined) return null;

    const name = spaceName(space.name, space.room_id);
    const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(space) });
    const savedPath = spacePaths[space.room_id];

    return {
      href,
      activePrefix: href,
      navigateHref: spaceNavigationHref(href, savedPath, mobile),
      initial: initial(name),
      avatar: space.avatar_url,
      label: name,
      unread: unreadSpaceIds.has(space.room_id),
    };
  }

  function folderLabel(folder: SidebarFolder): string {
    return (
      folderName(folder, (roomId) => spacesById.get(roomId)?.name ?? null) ?? $i18n.t('nav.folder')
    );
  }

  function knownContent(folder: SidebarFolder): string[] {
    return folder.content.filter((roomId) => spacesById.has(roomId));
  }

  function folderUnread(folder: SidebarFolder): boolean {
    return folder.content.some((roomId) => unreadSpaceIds.has(roomId));
  }

  function folderActive(folder: SidebarFolder): boolean {
    return folder.content.some((roomId) => {
      const item = spaceItem(roomId);
      return item !== null && isActive(item);
    });
  }

  function folderOpen(folder: SidebarFolder): boolean {
    return openFolders.has(folder.id);
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

  function dropping(ref: LayoutRef, instruction: DropInstruction): boolean {
    return (
      dropState !== null && dropState.instruction === instruction && refsEqual(dropState.item, ref)
    );
  }

  function isDragged(ref: LayoutRef): boolean {
    return dragged !== null && refsEqual(dragged, ref);
  }

  const noAttachment = (): undefined => undefined;
  const dragList = createDragList<LayoutRef>(refsEqual);

  function dragSource(ref: LayoutRef) {
    return mobile
      ? noAttachment
      : dragList.draggable(ref, (next) => {
          dragged = next;
        });
  }

  function dropTarget(ref: LayoutRef, allowInto: boolean) {
    return mobile
      ? noAttachment
      : dragList.dropTarget(ref, {
          allowInto,
          onState: (next) => {
            dropState = next;
          },
          onDrop: (source, target, instruction) => {
            onReorder?.(source, target, instruction);
          },
        });
  }

  const monitor = dragList.autoScroll();

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
<!-- eslint-disable @typescript-eslint/no-confusing-void-expression -- a local
     snippet types as returning void, and the rule reads every {@render} of one
     as a void expression in an expression position -->
{#snippet nothing()}{/snippet}

{#snippet itemBody(item: RailItem, active: boolean)}
  {#if item.icon}
    <span class="icon" aria-hidden="true"><item.icon weight={active ? 'fill' : 'regular'} /></span>
  {:else}
    <Avatar class="space-initial" src={item.avatar} initials={item.initial} size="small" />
  {/if}
  {#if item.unreadCount}
    <span class="unread-count" aria-hidden="true">{item.unreadCount}</span>
  {:else if item.unread}
    <span class="unread-dot" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet itemLink(item: RailItem, props: Record<string, unknown>, held: boolean)}
  {@const active = isActive(item)}
  <a
    {...props}
    class="rail-item sable-selection-layer"
    class:space-item={Boolean(item.initial)}
    class:active
    href={item.navigateHref ?? item.href}
    draggable={held ? 'false' : undefined}
    onclick={mobile
      ? () => {
          navigate(item);
        }
      : undefined}
    aria-label={$i18n.t(item.label)}
    aria-current={active ? 'page' : undefined}
  >
    {@render itemBody(item, active)}
  </a>
{/snippet}

{#snippet railItem(item: RailItem, held: boolean)}
  {#if mobile}
    {@render itemLink(item, {}, held)}
  {:else}
    {@const label = $i18n.t(item.label)}
    {#snippet trigger({ props }: { props: Record<string, unknown> })}
      {@render itemLink(item, props, held)}
    {/snippet}
    <Tooltip {label} side="right" {trigger} />
  {/if}
{/snippet}

{#snippet spaceSlotBody(item: RailItem, ref: LayoutRef, folderId?: string)}
  <div
    class="rail-slot"
    class:nested={folderId !== undefined}
    class:drop-above={dropping(ref, 'above')}
    class:drop-below={dropping(ref, 'below')}
    class:drop-into={dropping(ref, 'into')}
    class:dragged={isDragged(ref)}
    {@attach dragSource(ref)}
    {@attach dropTarget(ref, folderId === undefined)}
  >
    {@render railItem(item, !mobile)}
  </div>
{/snippet}

{#snippet spaceSlot(roomId: string, folderId?: string)}
  {@const item = spaceItem(roomId)}
  {#if item !== null}
    {@const ref = { kind: 'space', roomId, folderId } satisfies LayoutRef}
    {#if folderId === undefined}
      <div
        class="rail-menu-anchor"
        oncontextmenu={(event) => {
          openSpaceContextMenu(event, roomId);
        }}
        role="presentation"
      >
        {@render spaceSlotBody(item, ref)}
      </div>
    {:else}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <div {...props} class="rail-menu-anchor">
              {@render spaceSlotBody(item, ref, folderId)}
            </div>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content class="sable-menu">
            <ContextMenu.Item
              class="sable-menu-item"
              onSelect={() => {
                onRemoveFromFolder?.(roomId, folderId);
              }}
            >
              <ArrowLineUpIcon />
              {$i18n.t('nav.folderRemoveSpace')}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    {/if}
  {/if}
{/snippet}

{#snippet folderMenuItems(folder: SidebarFolder)}
  <ContextMenu.Item
    class="sable-menu-item"
    onSelect={() => {
      onRenameFolder?.(folder);
    }}
  >
    <PencilSimpleIcon />
    {$i18n.t('nav.folderRename')}
  </ContextMenu.Item>
  <ContextMenu.Item
    class="sable-menu-item"
    onSelect={() => {
      onUngroupFolder?.(folder.id);
    }}
  >
    <FolderOpenIcon />
    {$i18n.t('nav.folderUngroup')}
  </ContextMenu.Item>
{/snippet}

{#snippet folderTiles(folder: SidebarFolder)}
  <span class="folder-tiles" aria-hidden="true">
    {#each knownContent(folder).slice(0, 4) as roomId (roomId)}
      {@const space = spacesById.get(roomId)}
      <Avatar
        class="folder-tile"
        src={space?.avatar_url}
        initials={initial(spaceName(space?.name ?? null, roomId))}
        size="small"
      />
    {/each}
  </span>
{/snippet}

{#snippet folderButton(folder: SidebarFolder, props: Record<string, unknown>)}
  <button
    {...props}
    type="button"
    class="rail-item folder-preview sable-selection-layer"
    class:active={folderActive(folder)}
    aria-expanded="false"
    aria-label={$i18n.t('nav.folderExpand', { name: folderLabel(folder) })}
    onclick={() => {
      onToggleFolder?.(folder.id);
    }}
  >
    {@render folderTiles(folder)}
    {#if folderUnread(folder)}
      <span class="unread-dot" aria-hidden="true"></span>
    {/if}
  </button>
{/snippet}

{#snippet closedFolder(folder: SidebarFolder)}
  {@const ref = { kind: 'folder', folderId: folder.id } satisfies LayoutRef}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div
          {...props}
          class="rail-slot"
          class:drop-above={dropping(ref, 'above')}
          class:drop-below={dropping(ref, 'below')}
          class:drop-into={dropping(ref, 'into')}
          class:dragged={isDragged(ref)}
          {@attach dragSource(ref)}
          {@attach dropTarget(ref, true)}
        >
          {#if mobile}
            {@render folderButton(folder, {})}
          {:else}
            {@const label = folderLabel(folder)}
            {#snippet trigger({ props: triggerProps }: { props: Record<string, unknown> })}
              {@render folderButton(folder, triggerProps)}
            {/snippet}
            <Tooltip {label} side="right" {trigger} />
          {/if}
        </div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content class="sable-menu">
        {@render folderMenuItems(folder)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
{/snippet}

{#snippet openFolder(folder: SidebarFolder)}
  {@const ref = { kind: 'folder', folderId: folder.id } satisfies LayoutRef}
  <div
    class="folder-open"
    class:drop-above={dropping(ref, 'above')}
    class:drop-below={dropping(ref, 'below')}
    {@attach dropTarget(ref, false)}
  >
    <div class="folder-card">
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="folder-collapse"
              aria-expanded="true"
              aria-label={$i18n.t('nav.folderCollapse', { name: folderLabel(folder) })}
              onclick={() => {
                onToggleFolder?.(folder.id);
              }}
            >
              <CaretUpIcon weight="fill" />
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content class="sable-menu">
            {@render folderMenuItems(folder)}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {#each folder.content as roomId (roomId)}
        {@render spaceSlot(roomId, folder.id)}
      {/each}
    </div>
  </div>
{/snippet}

<div class="rail">
  <div class="rail-scroll" {@attach mobile ? noAttachment : monitor}>
    <ul class="rail-stack">
      {#each [...items, ...directItems] as item (item.href)}
        <li><div class="rail-pad">{@render railItem(item, false)}</div></li>
      {/each}
      {#each entries as entry (entry.kind === 'space' ? entry.room_id : entry.id)}
        <li>
          {#if entry.kind === 'space'}
            {@render spaceSlot(entry.room_id)}
          {:else if knownContent(entry).length === 0}
            {@render nothing()}
          {:else if folderOpen(entry)}
            {@render openFolder(entry)}
          {:else}
            {@render closedFolder(entry)}
          {/if}
        </li>
      {/each}
    </ul>
    <div class="dynamic-rail-region" aria-hidden="true"></div>
  </div>
  <ul class="rail-stack rail-bottom">
    <li><div class="rail-pad">{@render railItem(createItem, false)}</div></li>
  </ul>
</div>

{#if contextSpace}
  <RoomOptionsMenu
    room={contextSpace}
    anchor={contextAnchor}
    bind:open={contextOpen}
    onSettings={(room: RoomSummary) => {
      settingsRoomId = room.room_id;
    }}
    onLeave={(room: RoomSummary) => {
      leaveRoomId = room.room_id;
    }}
  />
{/if}

{#if settingsRoom}
  <RoomSettingsDialog
    open
    room={settingsRoom}
    onOpenChange={(next) => {
      if (!next) settingsRoomId = null;
    }}
  />
{/if}

{#if leaveRoom}
  <LeaveRoomDialog
    open
    room={leaveRoom}
    onOpenChange={(next) => {
      if (!next) leaveRoomId = null;
    }}
  />
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
    margin: var(--space-100) auto;
    width: 2rem;
  }

  .rail-stack {
    align-items: center;
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: var(--space-hairline) 0;
  }

  .rail-pad,
  .rail-slot,
  .folder-open {
    padding: var(--space-150) 0;
  }

  .rail-bottom {
    padding: var(--space-100) 0 var(--space-200);
  }

  .rail-item {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    height: 2.625rem;
    justify-content: center;
    position: relative;
    text-decoration: none;
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
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    justify-content: center;
    line-height: 1;
    min-width: 1.125rem;
    padding: 0 var(--space-hairline);
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

  .rail-menu-anchor {
    display: contents;
  }

  .rail-slot {
    position: relative;
  }

  .rail-slot.dragged {
    opacity: 0.4;
  }

  .rail-slot.drop-above::after,
  .rail-slot.drop-below::after,
  .folder-open.drop-above::after,
  .folder-open.drop-below::after {
    background: var(--sable-primary-main);
    border-radius: var(--radius-pill);
    content: '';
    height: 2px;
    left: 0;
    pointer-events: none;
    position: absolute;
    right: 0;
  }

  .rail-slot.drop-above::after,
  .folder-open.drop-above::after {
    top: -1px;
  }

  .rail-slot.drop-below::after,
  .folder-open.drop-below::after {
    bottom: -1px;
  }

  .rail-slot.drop-into :global(.rail-item) {
    outline: 2px solid var(--sable-primary-main);
    outline-offset: 1px;
  }

  .folder-preview {
    background: var(--sable-bg-container-hover);
    border: 0;
    cursor: pointer;
    padding: var(--space-hairline);
  }

  .folder-tiles {
    display: grid;
    gap: var(--space-hairline);
    grid-template-columns: repeat(2, 1fr);
    height: 100%;
    width: 100%;
  }

  .folder-tiles :global(.folder-tile) {
    border-radius: 0.25rem;
    font-size: 0.5rem;
    height: 100%;
    min-height: 0;
    min-width: 0;
    width: 100%;
  }

  .folder-open {
    position: relative;
  }

  .folder-card {
    align-items: center;
    background: var(--sable-bg-container-hover);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    padding: var(--space-100);
  }

  .folder-card .rail-slot {
    padding: var(--space-100) 0;
  }

  .folder-card .rail-slot.nested :global(.rail-item) {
    height: 2.125rem;
    width: 2.125rem;
  }

  .folder-collapse {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    height: 1.25rem;
    justify-content: center;
    padding: 0;
    width: 2.125rem;
  }

  .folder-collapse:hover {
    background: var(--sable-bg-container);
  }

  .folder-collapse:focus-visible {
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
