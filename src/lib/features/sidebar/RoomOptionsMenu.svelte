<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import type { RoomTag } from '#src/generated/RoomTag';
  import { DropdownMenu } from 'bits-ui';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import StarIcon from 'phosphor-svelte/lib/StarIcon';
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';

  import type { NotificationModeView } from '#src/generated/NotificationModeView';
  import BellIcon from 'phosphor-svelte/lib/BellIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { matrixToUrl } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import IconContext from 'phosphor-svelte/lib/IconContext';

  import '#lib/ui/primitives/menu.css';

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
  // Rebuilt per run so a revoked space drops back out. Asked on open, like the
  // notification mode below: an effect here would re-run on every room list
  // diff, and this menu is mounted once per row.
  const manageable = new SvelteSet<string>();
  let manageableRun = 0;

  function readManageableSpaces(): void {
    const candidates = [...addableSpaces.map((space) => space.room_id), parentSpaceId].filter(
      (id): id is string => id !== null
    );

    const run = ++manageableRun;
    manageable.clear();
    for (const spaceId of candidates) {
      void core
        .roomPermissions(spaceId)
        .then((permissions) => {
          if (run !== manageableRun || !permissions.can_manage_children) return;
          manageable.add(spaceId);
        })
        .catch((error: unknown) => {
          console.debug('[sable room] space permissions unavailable', error);
        });
    }
  }

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

  let notificationMode = $state<NotificationModeView | null | undefined>();
  let notificationDefault = $state<NotificationModeView | undefined>();
  const notificationModes: readonly { mode: NotificationModeView | null; label: string }[] = [
    { mode: null, label: 'room.notifyDefault' },
    { mode: 'all', label: 'room.notifyAll' },
    { mode: 'mentions', label: 'room.notifyMentions' },
    { mode: 'mute', label: 'room.notifyMute' },
  ];
  const modeLabels: Record<NotificationModeView, string> = {
    all: 'room.notifyAll',
    mentions: 'room.notifyMentions',
    mute: 'room.notifyMute',
  };

  let defaultLabel = $derived(notificationDefault ? $i18n.t(modeLabels[notificationDefault]) : '');

  $effect(() => {
    void settingsChanges.version;
    if (notificationMode !== undefined) void readNotificationMode();
  });

  async function readNotificationMode(): Promise<void> {
    try {
      const settings = await core.notificationSettings(room.room_id);
      notificationMode = settings.room;
      notificationDefault = settings.default;
    } catch (error) {
      report(error);
    }
  }

  function setNotificationMode(mode: NotificationModeView | null): void {
    notificationMode = mode;
    void core.setRoomNotificationMode(room.room_id, mode).catch(report);
  }

  async function copyLink(): Promise<void> {
    try {
      const via = room.canonical_alias ? [] : await core.roomViaServers(room.room_id);
      await navigator.clipboard.writeText(matrixToUrl(room.canonical_alias ?? room.room_id, via));
    } catch (error) {
      console.debug('[sable room] clipboard unavailable', error);
    }
  }
</script>

<DropdownMenu.Root
  onOpenChange={(open) => {
    if (!open) return;
    void readNotificationMode();
    readManageableSpaces();
  }}
>
  <DropdownMenu.Trigger class="room-options-trigger" aria-label={$i18n.t('room.menuLabel')}>
    <DotsThreeIcon />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    class="sable-menu room-options-menu"
    side="bottom"
    align="end"
    sideOffset={4}
  >
    <IconContext values={{ 'aria-hidden': 'true' }}>
      <DropdownMenu.Item
        class="sable-menu-item"
        onSelect={() => {
          toggleTag('favourite', favourite);
        }}
      >
        <StarIcon weight={favourite ? 'fill' : 'regular'} />
        {$i18n.t('room.menuFavourite')}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="sable-menu-item"
        onSelect={() => {
          toggleTag('low_priority', lowPriority);
        }}
      >
        <TrayIcon weight={lowPriority ? 'fill' : 'regular'} />
        {$i18n.t('room.menuLowPriority')}
      </DropdownMenu.Item>

      {#if room.is_direct}
        <DropdownMenu.Item class="sable-menu-item" onSelect={convertToGroup}>
          <ChatCircleIcon />
          {$i18n.t('room.menuConvertToGroup')}
        </DropdownMenu.Item>
      {/if}

      <DropdownMenu.Separator class="sable-menu-separator" />

      <DropdownMenu.Item class="sable-menu-item" onSelect={copyLink}>
        <LinkIcon />
        {$i18n.t('room.menuCopyLink')}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="sable-menu-item"
        onSelect={() => {
          onSettings(room);
        }}
      >
        <GearIcon />
        {$i18n.t('room.menuSettings')}
      </DropdownMenu.Item>

      {#if !room.is_space}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger class="sable-menu-item">
            <BellIcon />
            {$i18n.t('room.menuNotifications')}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class="sable-menu room-options-menu" sideOffset={4}>
            <IconContext values={{ 'aria-hidden': 'true' }}>
              {#each notificationModes as option (option.mode ?? 'default')}
                {@const selected = notificationMode === option.mode}
                <DropdownMenu.Item
                  class="sable-menu-item"
                  aria-checked={selected}
                  onSelect={() => {
                    setNotificationMode(option.mode);
                  }}
                >
                  <span class="mode-check" aria-hidden="true">{selected ? '\u2713' : ''}</span>
                  {$i18n.t(option.label, { mode: defaultLabel })}
                </DropdownMenu.Item>
              {/each}
            </IconContext>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      {/if}

      {#if !room.is_space && offeredSpaces.length > 0}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger class="sable-menu-item">
            <UsersThreeIcon />
            {$i18n.t('room.menuAddToSpace')}
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class="sable-menu room-options-menu" sideOffset={4}>
            <IconContext values={{ 'aria-hidden': 'true' }}>
              {#each offeredSpaces as space (space.room_id)}
                <DropdownMenu.Item
                  class="sable-menu-item"
                  onSelect={() => {
                    addToSpace(space.room_id);
                  }}
                >
                  {space.name ?? space.room_id}
                </DropdownMenu.Item>
              {/each}
            </IconContext>
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      {/if}

      {#if !room.is_space && removableParent}
        <DropdownMenu.Item
          class="sable-menu-item"
          onSelect={() => {
            removeFromSpace(removableParent.room_id);
          }}
        >
          <UsersThreeIcon />
          {$i18n.t('room.menuRemoveFromSpace', {
            space: removableParent.name ?? removableParent.room_id,
          })}
        </DropdownMenu.Item>
      {/if}

      <DropdownMenu.Item
        class="sable-menu-item sable-menu-item-destructive"
        onSelect={() => {
          onLeave(room);
        }}
      >
        <SignOutIcon />
        {room.is_space ? $i18n.t('room.menuLeaveSpace') : $i18n.t('room.menuLeave')}
      </DropdownMenu.Item>
    </IconContext>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.room-options-menu) {
    --menu-min-width: 12rem;
    --menu-max-height: 20rem;
  }

  .mode-check {
    display: inline-block;
    text-align: center;
    width: 1rem;
  }

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
</style>
