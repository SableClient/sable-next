<script lang="ts">
  import type { RoomSummary } from '@/generated/RoomSummary';
  import type { RoomTag } from '@/generated/RoomTag';
  import { DropdownMenu } from 'bits-ui';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import StarIcon from 'phosphor-svelte/lib/StarIcon';
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';

  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { useRoomList } from '$lib/rooms/room-list.svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  interface Props {
    room: RoomSummary;
    parentSpaceId?: string | null;
    onSettings: (room: RoomSummary) => void;
    onLeave: (room: RoomSummary) => void;
  }

  let { room, parentSpaceId = null, onSettings, onLeave }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  // The core enriches tags once per room per subscription, so a toggle has to
  // hold its own answer until the next enrichment.
  const pendingTags = new SvelteMap<RoomTag, boolean>();

  let favourite = $derived(pendingTags.get('favourite') ?? room.tags.includes('favourite'));
  let lowPriority = $derived(pendingTags.get('low_priority') ?? room.tags.includes('low_priority'));
  let parentSpace = $derived(
    parentSpaceId === null
      ? null
      : (roomList.rooms.find((candidate) => candidate.room_id === parentSpaceId) ?? null)
  );
  let addableSpaces = $derived(
    roomList.rooms.filter(
      (candidate) =>
        candidate.is_space &&
        candidate.state === 'joined' &&
        candidate.room_id !== room.room_id &&
        !candidate.space_children.some((child) => child.room_id === room.room_id)
    )
  );

  // The space's own power levels govern the edge, so each candidate is asked.
  const manageable = new SvelteSet<string>();

  $effect(() => {
    const candidates = [...addableSpaces.map((space) => space.room_id), parentSpaceId].filter(
      (id): id is string => id !== null
    );

    let current = true;
    for (const spaceId of candidates) {
      void core
        .roomPermissions(spaceId)
        .then((permissions) => {
          if (!current || !permissions.can_manage_children) return;
          manageable.add(spaceId);
        })
        .catch((error: unknown) => {
          console.debug('[sable room] space permissions unavailable', error);
        });
    }
    return () => {
      current = false;
    };
  });

  let offeredSpaces = $derived(addableSpaces.filter((space) => manageable.has(space.room_id)));
  let removableParent = $derived(
    parentSpace !== null && manageable.has(parentSpace.room_id) ? parentSpace : null
  );

  function report(error: unknown): void {
    console.warn('[sable room] room action failed', error);
  }

  function toggleTag(tag: RoomTag, current: boolean): void {
    const next = !current;
    pendingTags.set(tag, next);
    void core.setRoomTag(room.room_id, tag, next).catch((error: unknown) => {
      pendingTags.delete(tag);
      report(error);
    });
  }

  /** One-directional, like v1: a DM becomes a group. */
  function convertToGroup(): void {
    void core.setDirect(room.room_id, false).catch(report);
  }

  function addToSpace(spaceId: string): void {
    void core.addToSpace(spaceId, room.room_id).catch(report);
  }

  function removeFromSpace(spaceId: string): void {
    void core.removeFromSpace(spaceId, room.room_id).catch(report);
  }

  async function copyLink(): Promise<void> {
    const address = room.canonical_alias ?? room.room_id;
    try {
      await navigator.clipboard.writeText(`https://matrix.to/#/${address}`);
    } catch (error) {
      console.debug('[sable room] clipboard unavailable', error);
    }
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="room-options-trigger" aria-label={$i18n.t('room.menuLabel')}>
    <DotsThreeIcon />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="room-options-menu" side="bottom" align="end" sideOffset={4}>
    <DropdownMenu.Item
      class="room-options-item"
      onSelect={() => {
        toggleTag('favourite', favourite);
      }}
    >
      <StarIcon size={16} weight={favourite ? 'fill' : 'regular'} />
      {$i18n.t('room.menuFavourite')}
    </DropdownMenu.Item>
    <DropdownMenu.Item
      class="room-options-item"
      onSelect={() => {
        toggleTag('low_priority', lowPriority);
      }}
    >
      <TrayIcon size={16} weight={lowPriority ? 'fill' : 'regular'} />
      {$i18n.t('room.menuLowPriority')}
    </DropdownMenu.Item>

    {#if room.is_direct}
      <DropdownMenu.Item class="room-options-item" onSelect={convertToGroup}>
        <ChatCircleIcon size={16} />
        {$i18n.t('room.menuConvertToGroup')}
      </DropdownMenu.Item>
    {/if}

    <DropdownMenu.Separator class="room-options-separator" />

    <DropdownMenu.Item class="room-options-item" onSelect={copyLink}>
      <LinkIcon size={16} />
      {$i18n.t('room.menuCopyLink')}
    </DropdownMenu.Item>
    <DropdownMenu.Item
      class="room-options-item"
      onSelect={() => {
        onSettings(room);
      }}
    >
      <GearIcon size={16} />
      {$i18n.t('room.menuSettings')}
    </DropdownMenu.Item>

    {#if !room.is_space && offeredSpaces.length > 0}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger class="room-options-item">
          <UsersThreeIcon size={16} />
          {$i18n.t('room.menuAddToSpace')}
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="room-options-menu" sideOffset={4}>
          {#each offeredSpaces as space (space.room_id)}
            <DropdownMenu.Item
              class="room-options-item"
              onSelect={() => {
                addToSpace(space.room_id);
              }}
            >
              {space.name ?? space.room_id}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {/if}

    {#if !room.is_space && removableParent}
      <DropdownMenu.Item
        class="room-options-item"
        onSelect={() => {
          removeFromSpace(removableParent.room_id);
        }}
      >
        <UsersThreeIcon size={16} />
        {$i18n.t('room.menuRemoveFromSpace', {
          space: removableParent.name ?? removableParent.room_id,
        })}
      </DropdownMenu.Item>
    {/if}

    <DropdownMenu.Item
      class="room-options-item room-options-destructive"
      onSelect={() => {
        onLeave(room);
      }}
    >
      <SignOutIcon size={16} />
      {room.is_space ? $i18n.t('room.menuLeaveSpace') : $i18n.t('room.menuLeave')}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.room-options-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    height: 1.5rem;
    justify-content: center;
    padding: 0;
    width: 1.5rem;
  }

  :global(.room-options-trigger:hover),
  :global(.room-options-trigger[data-state='open']) {
    background: var(--sable-surface-var-container);
    color: var(--sable-bg-on-container);
  }

  :global(.room-options-trigger:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.room-options-menu) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    max-height: 20rem;
    min-width: 12rem;
    overflow: auto;
    padding: 0.25rem;
    z-index: var(--layer-menu);
  }

  :global(.room-options-item) {
    align-items: center;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    min-height: 2.25rem;
    padding: 0 var(--space-1);
  }

  :global(.room-options-item[data-highlighted]) {
    background: var(--sable-bg-container-hover);
  }

  :global(.room-options-separator) {
    background: var(--sable-bg-container-line);
    height: 1px;
    margin: 0.25rem 0;
  }

  :global(.room-options-destructive svg) {
    color: var(--sable-crit-main);
  }

  :global(.room-options-destructive[data-highlighted]) {
    background: color-mix(in oklab, var(--sable-crit-main) 12%, var(--sable-bg-container));
    color: var(--sable-crit-main);
  }
</style>
