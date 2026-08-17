<script lang="ts">
  import type { RoomPermissionsView } from '@/generated/RoomPermissionsView';
  import type { RoomSummary } from '@/generated/RoomSummary';
  import type { SpaceHierarchyRoomView } from '@/generated/SpaceHierarchyRoomView';
  import { DropdownMenu } from 'bits-ui';
  import { SvelteSet } from 'svelte/reactivity';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { roomPathParam, roomPathParamFromId, useRoomList } from '$lib/rooms/room-list.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import Skeleton from '$lib/ui/primitives/Skeleton.svelte';

  import {
    buildHierarchySections,
    type HierarchyRoom,
    type HierarchySection,
  } from './space-hierarchy';
  import { initials } from './timeline-format';

  interface Props {
    space: RoomSummary | null;
  }

  let { space }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const joining = new SvelteSet<string>();
  const removed = new SvelteSet<string>();
  const closed = new SvelteSet<string>();

  let rooms = $state.raw<SpaceHierarchyRoomView[]>([]);
  let nextBatch = $state<string | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let permissions = $state<RoomPermissionsView | null>(null);

  let spaceId = $derived(space?.room_id ?? null);
  let canManage = $derived(permissions?.can_manage_children ?? false);
  let joinedIds = $derived(
    new Set(roomList.rooms.filter((room) => room.state === 'joined').map((room) => room.room_id))
  );
  let sections = $derived.by<HierarchySection[]>(() => {
    if (spaceId === null) return [];
    return buildHierarchySections(rooms, spaceId)
      .map((section) => ({
        ...section,
        rooms: section.rooms.filter((entry) => !removed.has(entry.key)),
      }))
      .filter((section) => section.rooms.length > 0);
  });

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    let current = true;
    rooms = [];
    nextBatch = null;
    failed = false;
    loading = true;
    removed.clear();
    closed.clear();

    void core
      .spaceHierarchy(target)
      .then((page) => {
        if (!current) return;
        rooms = page.rooms;
        nextBatch = page.nextBatch;
      })
      .catch((error: unknown) => {
        console.warn('[sable lobby] hierarchy unavailable', error);
        if (current) failed = true;
      })
      .finally(() => {
        if (current) loading = false;
      });

    return () => {
      current = false;
    };
  });

  $effect(() => {
    const target = spaceId;
    if (!target) return;

    let current = true;
    permissions = null;
    void core
      .roomPermissions(target)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch((error: unknown) => {
        console.debug('[sable lobby] permissions unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  async function loadMore(): Promise<void> {
    const target = spaceId;
    if (!target || nextBatch === null || loading) return;

    loading = true;
    try {
      const page = await core.spaceHierarchy(target, nextBatch);
      rooms = [...rooms, ...page.rooms];
      nextBatch = page.nextBatch;
    } catch (error) {
      console.warn('[sable lobby] further pages unavailable', error);
      failed = true;
    } finally {
      loading = false;
    }
  }

  function open(child: SpaceHierarchyRoomView): void {
    const target = roomPathParamFromId(child.room_id);
    if (child.is_space) {
      void goto(resolve('/(app)/space/[spaceId]', { spaceId: target }));
      return;
    }
    if (!space) return;
    void goto(
      resolve('/(app)/space/[spaceId]/[roomId]', {
        spaceId: roomPathParam(space),
        roomId: target,
      })
    );
  }

  async function join(child: SpaceHierarchyRoomView): Promise<void> {
    if (joining.has(child.room_id)) return;
    joining.add(child.room_id);
    try {
      // The alias is likelier to resolve for a room our server has not seen.
      await core.joinRoom(child.canonical_alias ?? child.room_id);
      open(child);
    } catch (error) {
      console.warn('[sable lobby] join failed', error);
    } finally {
      joining.delete(child.room_id);
    }
  }

  /** The section's own space owns the edge, so it is what the removal targets. */
  async function remove(section: HierarchySection, entry: HierarchyRoom): Promise<void> {
    const parentId = section.space?.room_id ?? spaceId;
    if (!parentId) return;

    try {
      await core.removeFromSpace(parentId, entry.room.room_id);
      removed.add(entry.key);
    } catch (error) {
      console.warn('[sable lobby] remove failed', error);
    }
  }

  async function copyLink(child: SpaceHierarchyRoomView): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        `https://matrix.to/#/${child.canonical_alias ?? child.room_id}`
      );
    } catch (error) {
      console.debug('[sable lobby] clipboard unavailable', error);
    }
  }

  function toggle(key: string): void {
    if (closed.has(key)) closed.delete(key);
    else closed.add(key);
  }

  function label(child: SpaceHierarchyRoomView): string {
    return child.name ?? child.canonical_alias ?? child.room_id;
  }
</script>

<section class="lobby" aria-label={$i18n.t('nav.lobby')}>
  <header class="hero">
    <Avatar
      src={space?.avatar_url ?? null}
      initials={initials(space?.name ?? '')}
      size="large"
      shape="room"
    />
    <h1>{space?.name ?? $i18n.t('nav.space')}</h1>
    {#if space?.topic}<p class="topic">{space.topic}</p>{/if}
  </header>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.lobbyFailed')}</Alert>
  {/if}

  {#if loading && sections.length === 0}
    <div class="category">
      <ul class="rooms">
        {#each [0, 1, 2] as placeholder (placeholder)}
          <li class="room">
            <Skeleton class="room-avatar-skeleton" />
            <div class="room-text">
              <Skeleton style="height: 1rem; width: 30%" />
              <Skeleton style="height: 0.8125rem; width: 60%" />
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {:else if sections.length === 0 && !failed}
    <p class="empty">{$i18n.t('room.lobbyEmpty')}</p>
  {:else}
    {#each sections as section (section.key)}
      {@const isClosed = closed.has(section.key)}
      <div class="section">
        <div class="section-header">
          <button
            class="section-toggle"
            type="button"
            aria-expanded={!isClosed}
            onclick={() => {
              toggle(section.key);
            }}
          >
            {#if section.space}
              <Avatar
                src={section.space.avatar_url}
                initials={initials(label(section.space))}
                size="small"
                shape="room"
              />
              <span class="section-name">{label(section.space)}</span>
              {#if section.suggested}
                <span class="badge">{$i18n.t('room.lobbySuggested')}</span>
              {/if}
            {:else}
              <span class="section-name">{$i18n.t('nav.rooms')}</span>
            {/if}
            <span class="caret" class:closed={isClosed} aria-hidden="true"><CaretDownIcon /></span>
          </button>
          {#if section.space}
            {@const sectionSpace = section.space}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="room-menu-trigger"
                aria-label={$i18n.t('room.menuLabel')}
              >
                <DotsThreeVerticalIcon />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                class="room-options-menu"
                side="bottom"
                align="end"
                sideOffset={4}
              >
                <DropdownMenu.Item
                  class="room-options-item"
                  onSelect={() => {
                    void copyLink(sectionSpace);
                  }}
                >
                  <LinkIcon size={16} />
                  {$i18n.t('room.menuCopyLink')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
        </div>

        {#if !isClosed}
          <div class="category">
            <ul class="rooms">
              {#each section.rooms as entry (entry.key)}
                {@const child = entry.room}
                {@const joined = joinedIds.has(child.room_id)}
                <li class="room">
                  <Avatar
                    src={child.avatar_url}
                    initials={initials(label(child))}
                    size="small"
                    shape="room"
                  />
                  <div class="room-text">
                    <span class="room-name">
                      {label(child)}
                      {#if entry.suggested}
                        <span class="badge">{$i18n.t('room.lobbySuggested')}</span>
                      {/if}
                    </span>
                    <span class="room-meta">
                      <span class="members">
                        {$i18n.t('room.lobbyMembers', { count: child.num_joined_members })}
                      </span>
                      {#if child.topic}
                        <span class="divider" aria-hidden="true">|</span>
                        <span class="room-topic">{child.topic}</span>
                      {/if}
                    </span>
                  </div>

                  <div class="room-actions">
                    {#if joined}
                      <IconButton
                        variant="ghost"
                        size="small"
                        label={$i18n.t('room.lobbyOpen')}
                        onclick={() => {
                          open(child);
                        }}
                      >
                        <ArrowRightIcon />
                      </IconButton>
                    {:else}
                      <Button
                        size="small"
                        loading={joining.has(child.room_id)}
                        onclick={() => {
                          void join(child);
                        }}
                      >
                        <PlusIcon size={14} />
                        {$i18n.t('room.lobbyJoin')}
                      </Button>
                    {/if}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        class="room-menu-trigger"
                        aria-label={$i18n.t('room.menuLabel')}
                      >
                        <DotsThreeVerticalIcon />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content
                        class="room-options-menu"
                        side="bottom"
                        align="end"
                        sideOffset={4}
                      >
                        <DropdownMenu.Item
                          class="room-options-item"
                          onSelect={() => {
                            void copyLink(child);
                          }}
                        >
                          <LinkIcon size={16} />
                          {$i18n.t('room.menuCopyLink')}
                        </DropdownMenu.Item>
                        {#if canManage}
                          <DropdownMenu.Item
                            class="room-options-item room-options-destructive"
                            onSelect={() => {
                              void remove(section, entry);
                            }}
                          >
                            <TrashIcon size={16} />
                            {$i18n.t('room.lobbyRemove')}
                          </DropdownMenu.Item>
                        {/if}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/each}

    {#if nextBatch !== null}
      <div class="more">
        <Button {loading} onclick={loadMore}>{$i18n.t('room.lobbyMore')}</Button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .lobby {
    display: grid;
    gap: var(--space-3);
  }

  .hero {
    display: grid;
    justify-items: center;
    padding: var(--space-4) 0 var(--space-2);
    text-align: center;
  }

  h1 {
    font-size: var(--font-size-xlarge);
    line-height: var(--line-height-heading);
    margin: var(--space-2) 0 0;
  }

  .topic {
    color: var(--sable-surface-var-on-container);
    margin: var(--space-1) 0 0;
    max-width: 48ch;
  }

  /* v1 keeps every section card flush; only the heading distinguishes depth. */
  .section {
    display: grid;
    gap: var(--space-1);
  }

  .section-header {
    align-items: center;
    display: flex;
    gap: var(--space-1);
    padding: 0 var(--space-1);
  }

  .section-toggle {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-1);
    text-align: left;
  }

  .section-toggle:hover {
    background: var(--sable-bg-container-hover);
  }

  .section-toggle:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .section-name {
    font-size: var(--font-size-large);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: inline-flex;
  }

  .caret.closed {
    transform: rotate(-90deg);
  }

  .category {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    overflow: hidden;
  }

  .rooms {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .room {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }

  .room + .room {
    border-top: 1px solid var(--sable-bg-container-line);
  }

  .room:hover {
    background: var(--sable-bg-container-hover);
  }

  :global(.room-avatar-skeleton) {
    flex: none;
    height: 2.25rem;
    width: 2.25rem;
  }

  .room-text {
    display: grid;
    flex: 1;
    gap: 0.125rem;
    min-width: 0;
  }

  .room-name {
    align-items: center;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-1);
    min-width: 0;
  }

  .room-meta {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    min-width: 0;
  }

  .members {
    flex: none;
  }

  .divider {
    color: var(--sable-surface-var-container-line);
    flex: none;
  }

  .room-topic {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: 0 0.375rem;
  }

  .room-actions {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-1);
  }

  :global(.room-menu-trigger) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    height: var(--control-height-small);
    justify-content: center;
    padding: 0;
    width: var(--control-height-small);
  }

  :global(.room-menu-trigger:hover),
  :global(.room-menu-trigger[data-state='open']) {
    background: var(--sable-surface-var-container);
    color: var(--sable-bg-on-container);
  }

  :global(.room-menu-trigger:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  .more {
    display: flex;
    justify-content: center;
  }

  @media (width < 42rem) {
    .room {
      flex-wrap: wrap;
    }

    .room-actions {
      margin-left: auto;
    }
  }
</style>
