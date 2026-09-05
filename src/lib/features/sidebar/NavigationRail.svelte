<script lang="ts">
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import RoomSettingsDialog from '#lib/features/room/RoomSettingsDialog.svelte';

  import RoomOptionsMenu from './RoomOptionsMenu.svelte';
  import type { Component } from 'svelte';
  import { ContextMenu, DropdownMenu } from 'bits-ui';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { resolve } from '$app/paths';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParam } from '#lib/rooms/room-list.svelte.js';
  import { addUnread, type UnreadCount } from '#lib/rooms/spaces.js';
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
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { cursorAnchor, type CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { createDragList, type DropState } from '#lib/ui/drag-list.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { toInitials } from '#lib/ui/primitives/initials.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';
  import { resolveUnreadBadge } from '#lib/ui/primitives/unread-badge.js';
  import '#lib/ui/primitives/nav-tab.css';
  import ArrowLineUpIcon from 'phosphor-svelte/lib/ArrowLineUpIcon';
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpenIcon';
  import HashIcon from 'phosphor-svelte/lib/HashIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  const NO_UNREAD: UnreadCount = { unread: 0, highlight: 0 };

  type RailSection = 'home' | 'direct';

  type RailItem = {
    href: string;
    activePrefix: string;
    label: string;
    icon?: Component;
    initial?: string;
    avatar?: string | null;
    navigateHref?: string;
    unread?: UnreadCount;
    dm?: boolean;
    section?: RailSection;
    badge?: boolean;
  };

  interface Props {
    spaces: readonly RoomSummary[];
    spaceUnread?: ReadonlyMap<string, UnreadCount>;
    homeUnread?: UnreadCount;
    unspacedUnread?: UnreadCount;
    directRooms?: readonly RoomSummary[];
    directUnread?: UnreadCount;
    mobile?: boolean;
    onNavigate?: (href: string) => void;
    layout?: readonly SidebarItem[];
    openFolders?: ReadonlySet<string>;
    onToggleFolder?: (folderId: string) => void;
    onRenameFolder?: (folder: SidebarFolder) => void;
    onUngroupFolder?: (folderId: string) => void;
    onRemoveFromFolder?: (roomId: string, folderId: string) => void;
    onReorder?: (source: LayoutRef, target: LayoutRef, instruction: DropInstruction) => void;
    onMarkSectionRead?: (section: RailSection) => void;
  }

  let {
    spaces,
    spaceUnread = new Map(),
    homeUnread = NO_UNREAD,
    unspacedUnread = NO_UNREAD,
    directRooms = [],
    directUnread = NO_UNREAD,
    mobile = false,
    onNavigate,
    layout = [],
    openFolders = new Set(),
    onToggleFolder,
    onRenameFolder,
    onUngroupFolder,
    onRemoveFromFolder,
    onReorder,
    onMarkSectionRead,
  }: Props = $props();
  let spacePaths = $state(savedSpacePaths());
  let dragged = $state<LayoutRef | null>(null);
  let dropState = $state<DropState<LayoutRef> | null>(null);

  let items = $derived<readonly RailItem[]>([
    ...(preferences.showHome
      ? [
          {
            href: resolve('/(app)/home'),
            activePrefix: '/home',
            icon: HouseIcon,
            label: 'nav.home',
            unread: homeUnread,
            section: 'home',
            badge: false,
          } satisfies RailItem,
        ]
      : []),
    {
      href: resolve('/(app)/rooms'),
      activePrefix: '/rooms',
      icon: HashIcon,
      label: 'nav.unspaced',
      unread: unspacedUnread,
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
      unread: directUnread,
      dm: true,
      section: 'direct',
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

      return {
        href,
        activePrefix: href,
        initial: toInitials(name),
        avatar: room.avatar_url,
        label: name,
        unread: { unread: room.unread, highlight: room.highlight },
        dm: true,
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

  function outlined(item: RailItem): boolean {
    return item.icon !== undefined || item.dm === true;
  }

  let displayAnchor = $state.raw<CursorAnchor | null>(null);
  let displayOpen = $state(false);

  function openDisplayMenu(event: MouseEvent): void {
    const target = event.target;
    if (mobile) return;
    if (target instanceof Element && target.closest('a, button, [role="button"]')) return;

    event.preventDefault();
    displayAnchor = cursorAnchor(event);
    displayOpen = true;
  }

  const displayToggles = [
    { key: 'showUnreadCounts', label: 'settings.showUnreadCounts' },
    { key: 'badgeCountDMsOnly', label: 'settings.badgeCountDMsOnly' },
    { key: 'showPingCounts', label: 'settings.showPingCounts' },
  ] as const;
  const viewToggles = [
    { key: 'showHome', label: 'settings.showHome' },
    { key: 'uniformIcons', label: 'settings.uniformIcons' },
  ] as const;

  let contextSpace = $state<RoomSummary | null>(null);
  let contextAnchor = $state.raw<CursorAnchor | null>(null);
  let contextOpen = $state(false);
  let settingsRoomId = $state<string | null>(null);
  let leaveRoomId = $state<string | null>(null);

  let settingsRoom = $derived(spaces.find((space) => space.room_id === settingsRoomId) ?? null);
  let leaveRoom = $derived(spaces.find((space) => space.room_id === leaveRoomId) ?? null);

  function openSpaceContextMenu(event: MouseEvent, roomId: string): void {
    const space = spacesById.get(roomId);
    if (space === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    contextSpace = space;
    contextAnchor = cursorAnchor(event);
    contextOpen = true;
  }

  function spaceItem(roomId: string): RailItem | null {
    const space = spacesById.get(roomId);
    if (space === undefined) return null;

    const name = spaceName(space.name, space.room_id);
    const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(space) });
    const lobby = resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomPathParam(space) });
    const savedPath = spacePaths[space.room_id];

    return {
      href,
      activePrefix: href,
      navigateHref: spaceNavigationHref(href, savedPath, mobile, lobby),
      initial: toInitials(name),
      avatar: space.avatar_url,
      label: name,
      unread: spaceUnread.get(space.room_id),
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

  function folderUnread(folder: SidebarFolder): UnreadCount {
    return folder.content.reduce(
      (total, roomId) => addUnread(total, spaceUnread.get(roomId) ?? NO_UNREAD),
      NO_UNREAD
    );
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

{#snippet unreadMark(count: UnreadCount | undefined, dm: boolean)}
  <UnreadBadge counts={count} {dm} aria-hidden="true" />
{/snippet}

{#snippet itemBody(item: RailItem, active: boolean)}
  {#if item.icon}
    <span class="icon" aria-hidden="true"><item.icon weight={active ? 'fill' : 'regular'} /></span>
  {:else}
    <Avatar class="space-initial" src={item.avatar} initials={item.initial} uniform />
  {/if}
  {#if item.badge !== false}
    {@render unreadMark(item.unread, item.dm ?? false)}
  {/if}
{/snippet}

{#snippet itemLink(item: RailItem, props: Record<string, unknown>, held: boolean)}
  {@const active = isActive(item)}
  <a
    {...props}
    class="rail-item sable-nav-tab sable-nav-tab-side sable-current sable-selection-layer"
    class:sable-nav-tab-outlined={outlined(item)}
    class:space-item={Boolean(item.initial)}
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

{#snippet sectionItem(item: RailItem, section: RailSection)}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div {...props} class="rail-menu-anchor rail-section-anchor">
          {@render railItem(item, false)}
        </div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content class="sable-menu">
        <ContextMenu.Item
          class="sable-menu-item"
          disabled={resolveUnreadBadge(item.unread, preferences, item.dm ?? false) === null}
          onSelect={() => {
            onMarkSectionRead?.(section);
          }}
        >
          <ChecksIcon />
          {$i18n.t('nav.markSectionRead')}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
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
    {#each knownContent(folder) as roomId (roomId)}
      {@const space = spacesById.get(roomId)}
      <Avatar
        class="folder-tile"
        src={space?.avatar_url}
        name={spaceName(space?.name ?? null, roomId)}
        size="small"
      />
    {/each}
  </span>
{/snippet}

{#snippet folderButton(folder: SidebarFolder, props: Record<string, unknown>)}
  <button
    {...props}
    type="button"
    class="rail-item folder-preview sable-nav-tab sable-nav-tab-side sable-nav-tab-outlined
    sable-current sable-selection-layer"
    data-current={folderActive(folder) ? 'true' : undefined}
    aria-expanded="false"
    aria-label={$i18n.t('nav.folderExpand', { name: folderLabel(folder) })}
    onclick={() => {
      onToggleFolder?.(folder.id);
    }}
  >
    {@render folderTiles(folder)}
    {@render unreadMark(folderUnread(folder), false)}
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

<div class="rail" role="presentation" oncontextmenu={openDisplayMenu}>
  <div class="rail-scroll" {@attach mobile ? noAttachment : monitor}>
    <ul class="rail-stack">
      {#each [...items, ...directItems] as item (item.href)}
        <li>
          {#if item.section !== undefined}
            {@render sectionItem(item, item.section)}
          {:else}
            {@render railItem(item, false)}
          {/if}
        </li>
      {/each}
    </ul>
    {#if entries.length > 0}
      <div class="rail-separator" role="separator"></div>
      <ul class="rail-stack">
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
    {/if}
    <ul class="rail-stack">
      <li>{@render railItem(createItem, false)}</li>
    </ul>
  </div>
</div>

{#if !mobile}
  <DropdownMenu.Root bind:open={displayOpen}>
    <DropdownMenu.Content
      customAnchor={displayAnchor}
      class="sable-menu rail-display-menu"
      side="right"
      align="start"
      preventScroll={false}
      aria-label={$i18n.t('nav.displayOptions')}
    >
      {#each displayToggles as toggle (toggle.key)}
        {@const on = preferences[toggle.key]}
        <DropdownMenu.Item
          class="sable-menu-item"
          closeOnSelect={false}
          aria-checked={on}
          onSelect={() => {
            setPreference(toggle.key, !on);
          }}
        >
          <span class="sable-menu-check" aria-hidden="true">{on ? '✓' : ''}</span>
          {$i18n.t(toggle.label)}
        </DropdownMenu.Item>
      {/each}

      <DropdownMenu.Separator class="sable-menu-separator" />

      {#each viewToggles as toggle (toggle.key)}
        {@const on = preferences[toggle.key]}
        <DropdownMenu.Item
          class="sable-menu-item"
          closeOnSelect={false}
          aria-checked={on}
          onSelect={() => {
            setPreference(toggle.key, !on);
          }}
        >
          <span class="sable-menu-check" aria-hidden="true">{on ? '✓' : ''}</span>
          {$i18n.t(toggle.label)}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

{#if contextSpace}
  <RoomOptionsMenu
    room={contextSpace}
    anchor={contextAnchor}
    align="start"
    side="right"
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

  .rail-separator {
    background: var(--sable-bg-container-line);
    block-size: var(--border-width);
    margin: 0 auto;
    width: 1.5rem;
  }

  .rail-stack {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    list-style: none;
    margin: 0;
    padding: var(--space-300) 0 var(--space-200);
  }

  .icon {
    display: flex;
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .rail-menu-anchor {
    display: contents;
  }

  .rail-slot {
    position: relative;
    margin: -1px 0; /* when in open folders, makes all gaps equal (4px at 100% scaling) */
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
    top: -0.5rem;
  }

  .rail-slot.drop-below::after,
  .folder-open.drop-below::after {
    bottom: -0.5rem;
  }

  .rail-slot.nested.drop-above::after {
    top: -0.375rem;
  }

  .rail-slot.nested.drop-below::after {
    bottom: -0.375rem;
  }

  .rail-slot.drop-into :global(.rail-item) {
    outline: 2px solid var(--sable-primary-main);
    outline-offset: 1px;
  }

  .folder-preview {
    height: auto;
    min-height: 2.625rem;
    padding: var(--space-100);
  }

  .folder-tiles {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-050);
    place-content: center;
    width: 100%;
  }

  .folder-tiles :global(.folder-tile) {
    --avatar-size: 1rem;

    border-radius: var(--radii-300);
    font-size: calc(var(--font-size-small) * 0.6);
  }

  .folder-open {
    position: relative;
    width: var(--avatar-size-400);
  }

  .folder-card {
    align-items: center;
    background: transparent;
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radii-500);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
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
    height: 2.125rem;
    justify-content: center;
    padding: 0;
    width: 2.125rem;
  }

  .folder-collapse:hover {
    background: var(--sable-bg-container-hover);
  }

  .folder-collapse:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
