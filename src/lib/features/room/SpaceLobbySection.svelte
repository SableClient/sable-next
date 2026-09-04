<script lang="ts">
  import { DropdownMenu } from 'bits-ui';

  import IconContext from 'phosphor-svelte/lib/IconContext';

  import '#lib/ui/primitives/menu.css';
  import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import DotsSixVerticalIcon from 'phosphor-svelte/lib/DotsSixVerticalIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { createDragList, type DropState } from '#lib/ui/drag-list.js';
  import type { HierarchyRoom, HierarchyRoomView, HierarchySection } from './space-hierarchy';
  import { lobbyAction, placeholderRows } from './space-hierarchy';
  import LobbyRoomPlaceholder from './LobbyRoomPlaceholder.svelte';
  import type { DropEdge } from '#lib/ui/drag-list.js';

  interface Props {
    section: HierarchySection;
    closed: boolean;
    joinedIds: ReadonlySet<string>;
    invitedIds: ReadonlySet<string>;
    joining: ReadonlySet<string>;
    knocked: ReadonlySet<string>;
    joinErrors: ReadonlyMap<string, string>;
    canManage: boolean;
    label: (child: HierarchyRoomView) => string;
    onToggle: (key: string) => void;
    onOpen: (child: HierarchyRoomView) => void;
    onJoin: (child: HierarchyRoomView) => void;
    onCopyLink: (child: HierarchyRoomView) => void;
    onRemove: (section: HierarchySection, entry: HierarchyRoom) => void;
    onReorder: (
      section: HierarchySection,
      source: string,
      target: string,
      position: DropEdge
    ) => void;
    onMove: (section: HierarchySection, roomId: string, delta: number) => void;
  }

  let {
    section,
    closed,
    joinedIds,
    invitedIds,
    joining,
    knocked,
    joinErrors,
    canManage,
    label,
    onToggle,
    onOpen,
    onJoin,
    onCopyLink,
    onRemove,
    onReorder,
    onMove,
  }: Props = $props();

  let dragging = $state<string | null>(null);
  let dropState = $state<DropState<string> | null>(null);
  const dragList = createDragList<string>((left, right) => left === right);

  function dropTarget(roomId: string) {
    return dragList.dropTarget(roomId, {
      onState: (next) => {
        dropState = next;
      },
      onDrop: (source, target, instruction) => {
        if (instruction === 'into') return;
        onReorder(section, source, target, instruction);
      },
    });
  }

  function removeEntry(entry: HierarchyRoom): void {
    if (!confirm($i18n.t('room.lobbyRemoveConfirm', { room: label(entry.room) }))) return;
    onRemove(section, entry);
  }
</script>

<div class="section">
  <div class="section-header">
    <Button
      variant="ghost"
      class="section-toggle"
      aria-expanded={!closed}
      onclick={() => {
        onToggle(section.key);
      }}
    >
      {#if section.space}
        <Avatar src={section.space.avatar_url} name={label(section.space)} size="small" />
        <span class="section-name">{label(section.space)}</span>
        {#if section.suggested}<span class="badge">{$i18n.t('room.lobbySuggested')}</span>{/if}
      {:else}
        <span class="section-name">{$i18n.t('nav.rooms')}</span>
      {/if}
      <span class="caret" class:closed aria-hidden="true"><CaretDownIcon /></span>
    </Button>
    {#if section.space}
      {@const sectionSpace = section.space}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="room-menu-trigger sable-open"
          aria-label={$i18n.t('room.menuLabel')}
        >
          <DotsThreeVerticalIcon />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content class="sable-menu" side="bottom" align="end" sideOffset={4}>
          <IconContext values={{ 'aria-hidden': 'true' }}>
            <DropdownMenu.Item
              class="sable-menu-item"
              onSelect={() => {
                onCopyLink(sectionSpace);
              }}
            >
              <LinkIcon size={16} />{$i18n.t('room.menuCopyLink')}
            </DropdownMenu.Item>
          </IconContext>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </div>

  {#if !closed}
    <div class="category">
      <ul class="rooms">
        {#each section.rooms as entry (entry.key)}
          {@const child = entry.room}
          {@const joined = joinedIds.has(child.room_id)}
          {@const action = lobbyAction(child.join_rule, invitedIds.has(child.room_id))}
          <li
            class="room"
            class:dragging={dragging === child.room_id}
            class:drop-above={dropState?.item === child.room_id &&
              dropState.instruction === 'above'}
            class:drop-below={dropState?.item === child.room_id &&
              dropState.instruction === 'below'}
            {@attach canManage
              ? dragList.draggable(child.room_id, (next) => {
                  dragging = next;
                })
              : undefined}
            {@attach canManage ? dropTarget(child.room_id) : undefined}
          >
            {#if canManage}
              <span class="drag-handle" aria-hidden="true"><DotsSixVerticalIcon /></span>
            {/if}
            <Avatar src={child.avatar_url} name={label(child)} size="small" />
            <div class="room-text">
              <span class="room-name">
                {label(child)}
                {#if child.is_voice}<span class="badge">{$i18n.t('nav.voiceRoom')}</span>{/if}
                {#if entry.suggested}<span class="badge">{$i18n.t('room.lobbySuggested')}</span
                  >{/if}
              </span>
              <span class="room-meta">
                {#if child.num_joined_members !== null}
                  <span class="members"
                    >{$i18n.t('room.lobbyMembers', { count: child.num_joined_members })}</span
                  >
                {/if}
                {#if child.topic}
                  {#if child.num_joined_members !== null}<span class="divider" aria-hidden="true"
                      >|</span
                    >{/if}<span class="room-topic">{child.topic}</span>
                {/if}
              </span>
              {#if joinErrors.has(child.room_id)}
                <span class="room-error" role="alert">{joinErrors.get(child.room_id)}</span>
              {/if}
            </div>
            <div class="room-actions">
              {#if joined}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('room.lobbyOpen')}
                  onclick={() => {
                    onOpen(child);
                  }}
                >
                  <ArrowRightIcon />
                </IconButton>
              {:else if action}
                <Button
                  size="small"
                  disabled={knocked.has(child.room_id)}
                  loading={joining.has(child.room_id)}
                  onclick={() => {
                    onJoin(child);
                  }}
                >
                  <PlusIcon size={14} />{$i18n.t(
                    knocked.has(child.room_id)
                      ? 'room.lobbyKnockSent'
                      : action === 'knock'
                        ? 'room.lobbyKnock'
                        : 'room.lobbyJoin'
                  )}
                </Button>
              {/if}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class="room-menu-trigger sable-open"
                  aria-label={$i18n.t('room.menuLabel')}
                >
                  <DotsThreeVerticalIcon />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content class="sable-menu" side="bottom" align="end" sideOffset={4}>
                  <IconContext values={{ 'aria-hidden': 'true' }}>
                    <DropdownMenu.Item
                      class="sable-menu-item"
                      onSelect={() => {
                        onCopyLink(child);
                      }}
                    >
                      <LinkIcon size={16} />{$i18n.t('room.menuCopyLink')}
                    </DropdownMenu.Item>
                    {#if canManage}
                      <DropdownMenu.Item
                        class="sable-menu-item"
                        onSelect={() => {
                          onMove(section, child.room_id, -1);
                        }}
                      >
                        <ArrowUpIcon size={16} />{$i18n.t('room.lobbyMoveUp')}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="sable-menu-item"
                        onSelect={() => {
                          onMove(section, child.room_id, 1);
                        }}
                      >
                        <ArrowDownIcon size={16} />{$i18n.t('room.lobbyMoveDown')}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="sable-menu-item sable-menu-item-destructive"
                        onSelect={() => {
                          removeEntry(entry);
                        }}
                      >
                        <TrashIcon size={16} />{$i18n.t('room.lobbyRemove')}
                      </DropdownMenu.Item>
                    {/if}
                  </IconContext>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </li>
        {/each}
      </ul>
      {#if placeholderRows(section) > 0}
        <LobbyRoomPlaceholder rows={placeholderRows(section)} divided={section.rooms.length > 0} />
      {/if}
      {#if section.failed}
        <p class="section-failed">{$i18n.t('room.lobbyFailed')}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-200);
  }

  .section-header {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding: 0 var(--space-200);
  }

  :global(.section-toggle) {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-200);
    text-align: left;
  }

  :global(.section-toggle:hover) {
    background: var(--sable-bg-container-hover);
  }

  :global(.section-toggle:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .section-name {
    font-size: var(--font-size-heading);
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
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
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
    flex-wrap: wrap;
    gap: var(--space-400);
    padding: var(--space-300) var(--space-400);
  }

  .room + .room {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  .room.dragging {
    opacity: 0.4;
  }

  .room.drop-above {
    box-shadow: inset 0 2px 0 0 var(--sable-primary-main);
  }

  .room.drop-below {
    box-shadow: inset 0 -2px 0 0 var(--sable-primary-main);
  }

  .drag-handle {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    cursor: grab;
    display: inline-flex;
    flex: none;
    margin-left: calc(-1 * var(--space-300));
  }

  .room:hover {
    background: var(--sable-bg-container-hover);
  }

  .room-text {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .room-name {
    align-items: center;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    min-width: 0;
  }

  .room-meta {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    min-width: 0;
  }

  .members,
  .divider,
  .badge {
    flex: none;
  }

  .divider {
    color: var(--sable-surface-var-container-line);
  }

  .room-topic {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
  }

  .badge {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-150);
  }

  .room-actions {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-200);
    margin-left: auto;
  }

  .section-failed {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-300) var(--space-400);
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

  :global(.room-menu-trigger:hover) {
    background: var(--sable-surface-container-hover);
    color: var(--sable-surface-on-container);
  }

  :global(.room-menu-trigger:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (width >= 42rem) {
    .room {
      flex-wrap: nowrap;
    }

    .room-actions {
      margin-left: 0;
    }
  }
</style>
