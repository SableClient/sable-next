<script lang="ts">
  import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
  import { DropdownMenu } from 'bits-ui';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import type { HierarchyRoom, HierarchySection } from './space-hierarchy';
  import { lobbyAction } from './space-hierarchy';
  import { initials } from './timeline-format';

  interface Props {
    section: HierarchySection;
    closed: boolean;
    joinedIds: ReadonlySet<string>;
    invitedIds: ReadonlySet<string>;
    joining: ReadonlySet<string>;
    knocked: ReadonlySet<string>;
    canManage: boolean;
    label: (child: SpaceHierarchyRoomView) => string;
    onToggle: (key: string) => void;
    onOpen: (child: SpaceHierarchyRoomView) => void;
    onJoin: (child: SpaceHierarchyRoomView) => void;
    onCopyLink: (child: SpaceHierarchyRoomView) => void;
    onRemove: (section: HierarchySection, entry: HierarchyRoom) => void;
  }

  let {
    section,
    closed,
    joinedIds,
    invitedIds,
    joining,
    knocked,
    canManage,
    label,
    onToggle,
    onOpen,
    onJoin,
    onCopyLink,
    onRemove,
  }: Props = $props();
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
        <Avatar
          src={section.space.avatar_url}
          initials={initials(label(section.space))}
          size="small"
        />
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
        <DropdownMenu.Trigger class="room-menu-trigger" aria-label={$i18n.t('room.menuLabel')}>
          <DotsThreeVerticalIcon />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content class="room-options-menu" side="bottom" align="end" sideOffset={4}>
          <DropdownMenu.Item
            class="room-options-item"
            onSelect={() => {
              onCopyLink(sectionSpace);
            }}
          >
            <LinkIcon size={16} />{$i18n.t('room.menuCopyLink')}
          </DropdownMenu.Item>
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
          <li class="room">
            <Avatar src={child.avatar_url} initials={initials(label(child))} size="small" />
            <div class="room-text">
              <span class="room-name">
                {label(child)}
                {#if child.is_voice}<span class="badge">{$i18n.t('nav.voiceRoom')}</span>{/if}
                {#if entry.suggested}<span class="badge">{$i18n.t('room.lobbySuggested')}</span
                  >{/if}
              </span>
              <span class="room-meta">
                <span class="members"
                  >{$i18n.t('room.lobbyMembers', { count: child.num_joined_members })}</span
                >
                {#if child.topic}<span class="divider" aria-hidden="true">|</span><span
                    class="room-topic">{child.topic}</span
                  >{/if}
              </span>
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
                      onCopyLink(child);
                    }}
                  >
                    <LinkIcon size={16} />{$i18n.t('room.menuCopyLink')}
                  </DropdownMenu.Item>
                  {#if canManage}
                    <DropdownMenu.Item
                      class="room-options-item room-options-destructive"
                      onSelect={() => {
                        onRemove(section, entry);
                      }}
                    >
                      <TrashIcon size={16} />{$i18n.t('room.lobbyRemove')}
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

<style>
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
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-1);
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
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }

  .room + .room {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  .room:hover {
    background: var(--sable-bg-container-hover);
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

  .badge {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    padding: 0 0.375rem;
  }

  .room-actions {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-1);
    margin-left: auto;
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

  @media (width >= 42rem) {
    .room {
      flex-wrap: nowrap;
    }

    .room-actions {
      margin-left: 0;
    }
  }
</style>
