<script lang="ts">
  import type { Component } from 'svelte';
  import { resolve } from '$app/paths';
  import type { RoomPermissionsView, RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParam, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import CompassIcon from 'phosphor-svelte/lib/CompassIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import {
    createRoomPath,
    goToPage,
    scopedSearchPath,
  } from '#lib/features/room/room-navigation.js';

  interface Props {
    pathname: string;
    activeSpace: RoomListItemView | null;
    collapsed: boolean;
    onNavigate?: (href: string) => void;
  }

  let { pathname, activeSpace, collapsed, onNavigate }: Props = $props();

  const roomList = useRoomList();
  const core = useCoreClient();

  let spacePermissions = $state<RoomPermissionsView | null>(null);
  let directSection = $derived(pathname.startsWith('/direct'));
  // Keyed on the id: a room list diff hands back a fresh object for the
  // same space, and the permission effect below would re-run on every one.
  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  // Outside a space anyone may create a room; inside one it also has to land as
  // a child, which the space's own power levels govern.
  let canCreateHere = $derived(
    activeSpace === null || (spacePermissions?.can_manage_children ?? false)
  );
  let createRoomHref = $derived(createRoomPath(roomList.rooms, activeSpace, true));

  // A space browses its own children through the lobby; the public directory is
  // a home-level destination.
  let browseHref = $derived(
    activeSpace === null
      ? resolve('explore')
      : resolve('/(app)/space/[spaceId]/lobby', {
          spaceId: roomPathParam(activeSpace, roomList.rooms),
        })
  );

  let searchHref = $derived(
    activeSpace === null
      ? resolve('/(app)/search')
      : `${scopedSearchPath('space', activeSpace, activeSpace.room_id)}&space=${encodeURIComponent(
          activeSpace.room_id
        )}`
  );
  const joinHref = `${resolve('explore')}#explore-join-by-address`;
  let createSpaceHref = $derived(
    activeSpace === null
      ? resolve('create-space')
      : resolve('/(app)/space/[spaceId]/create-space', {
          spaceId: roomPathParam(activeSpace, roomList.rooms),
        })
  );
  let createSpaceLabel = $derived(
    activeSpace === null ? i18n.t('common.createSpace') : i18n.t('nav.createSubspace')
  );
  let browseLabel = $derived(
    activeSpace === null ? i18n.t('nav.exploreSpaces') : i18n.t('nav.lobby')
  );

  let createRoomLabel = $derived(
    activeSpace === null ? i18n.t('common.createRoom') : i18n.t('nav.createRoomInSpace')
  );

  const newChatHref = resolve('direct');

  function navigateTo(href: string): void {
    if (onNavigate) {
      onNavigate(href);
    } else {
      goToPage(href);
    }
  }

  // Adding a room to a space writes `m.space.child` there, so the space's own
  // power levels decide whether creating from inside it is offered at all.
  $effect(() => {
    const spaceId = activeSpaceId;
    if (!spaceId) {
      spacePermissions = null;
      return;
    }

    let current = true;
    spacePermissions = null;
    void core.rpc.members
      .permissions({ room_id: spaceId })
      .then((next) => {
        if (current) spacePermissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable nav] space permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });
</script>

<div class={['room-nav-actions', { collapsed }]}>
  {#snippet action(href: string, label: string, icon: Component)}
    {@const Icon = icon}
    {@const active = pathname === href}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- callers pass resolved hrefs -->
    <a
      class="nav-action selection-current selection-layer"
      {href}
      draggable="false"
      onclick={() => onNavigate?.(href)}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
    >
      <span class="room-icon" aria-hidden="true"><Icon weight={active ? 'fill' : 'regular'} /></span
      >
      {#if !collapsed}<span class="room-text"><span class="room-name">{label}</span></span>{/if}
    </a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/snippet}
  {#snippet createMenu()}
    <ActionMenu label={createRoomLabel} side="right" align="start">
      {#snippet trigger({ props })}
        <button
          {...props}
          type="button"
          class="room-nav-trigger"
          aria-label={collapsed ? createRoomLabel : undefined}
          style="align-items: center; display: flex; gap: var(--space-200); text-align: left"
        >
          <span class="room-icon" aria-hidden="true"><PlusIcon /></span>
          {#if !collapsed}<span class="room-text"
              ><span class="room-name">{createRoomLabel}</span></span
            >{/if}
        </button>
      {/snippet}
      <ActionMenuItem onSelect={() => navigateTo(createRoomHref)}>
        <PlusIcon />
        {createRoomLabel}
      </ActionMenuItem>
      <ActionMenuItem onSelect={() => navigateTo(createSpaceHref)}>
        <HouseIcon />
        {createSpaceLabel}
      </ActionMenuItem>
      <ActionMenuItem onSelect={() => navigateTo(joinHref)}>
        <LinkIcon />
        {i18n.t('nav.joinWithAddress')}
      </ActionMenuItem>
      <ActionMenuItem onSelect={() => navigateTo(browseHref)}>
        <CompassIcon />
        {browseLabel}
      </ActionMenuItem>
    </ActionMenu>
  {/snippet}
  {#if directSection}
    {@render action(newChatHref, i18n.t('nav.newChat'), PlusIcon)}
    {@render action(searchHref, i18n.t('nav.messageSearch'), MagnifyingGlassIcon)}
  {:else}
    {#if canCreateHere}
      {@render createMenu()}
    {/if}
    {@render action(browseHref, browseLabel, activeSpace === null ? CompassIcon : FlagIcon)}
    {@render action(searchHref, i18n.t('nav.messageSearch'), MagnifyingGlassIcon)}
  {/if}
</div>

<style>
  .room-nav-actions {
    display: grid;
    gap: var(--space-100);
    padding: var(--space-100) var(--space-200) var(--space-200);
  }

  :global(.room-nav-top:has(.room-banner) + .room-nav-content) .room-nav-actions {
    padding-top: var(--space-250);
  }

  .room-nav-actions a:hover,
  .room-nav-actions a:focus-visible,
  .room-nav-actions :global(.room-nav-trigger:hover),
  .room-nav-actions :global(.room-nav-trigger:focus-visible) {
    background: var(--bg-container-hover);
  }

  .room-nav-actions.collapsed {
    justify-items: center;
    padding: var(--space-100) 0;
  }

  .room-nav-actions.collapsed a,
  .room-nav-actions.collapsed :global(.room-nav-trigger) {
    justify-content: center;
    padding: 0;
    width: var(--control-height-medium);
  }

  .nav-action,
  :global(.room-nav-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    min-height: var(--control-height-medium);
    min-width: 0;
    padding: 0 var(--space-300) 0 calc(var(--space-200) + var(--room-depth, 0) * var(--space-400));
    text-decoration: none;
  }

  .nav-action[aria-current='page'] {
    background: var(--bg-container-active);
    color: var(--bg-on-container);
  }

  .nav-action[aria-current='page']:hover {
    background: var(--bg-container-active);
    color: var(--bg-on-container);
  }

  .room-icon,
  :global(.room-nav-trigger .room-icon) {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    flex: 0 0 1.5rem;
    height: 1.5rem;
    justify-content: center;
    overflow: hidden;
    width: 1.5rem;
  }

  .room-icon :global(svg),
  :global(.room-nav-trigger .room-icon svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .room-name,
  :global(.room-nav-trigger .room-name) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-text,
  :global(.room-nav-trigger .room-text) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .room-nav-actions a:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (--app-layout) {
    .room-nav-actions.collapsed :is(a, button) {
      width: var(--control-height-small);
    }

    .nav-action,
    :global(.room-nav-trigger) {
      min-height: 2.25rem;
    }
  }
</style>
