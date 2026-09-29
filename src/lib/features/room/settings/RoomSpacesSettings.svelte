<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';

  interface Props {
    room: RoomSummary | null;
  }

  interface ParentEvent {
    state_key?: unknown;
    content?: { canonical?: unknown; via?: unknown };
  }

  let { room }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  let parents = $state<{ spaceId: string; canonical: boolean }[]>([]);
  let run = 0;

  let roomId = $derived(room?.room_id ?? null);
  let listing = $derived(
    roomId === null
      ? []
      : roomList.rooms
          .filter(
            (space) =>
              space.is_space && space.space_children.some((child) => child.room_id === roomId)
          )
          .map((space) => space.room_id)
  );
  let entries = $derived.by(() => {
    const seen = new Set(parents.map((parent) => parent.spaceId));
    return [
      ...parents,
      ...listing.filter((id) => !seen.has(id)).map((spaceId) => ({ spaceId, canonical: false })),
    ].sort(
      (left, right) =>
        Number(right.canonical) - Number(left.canonical) ||
        roomList.labelFor(left.spaceId).localeCompare(roomList.labelFor(right.spaceId))
    );
  });

  $effect(() => {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    void core.commands
      .roomStateEventsRaw(target, 'm.space.parent', null)
      .then((events) => {
        if (current !== run) return;
        parents = (events as ParentEvent[]).flatMap((event) =>
          typeof event.state_key === 'string' &&
          event.state_key !== '' &&
          Array.isArray(event.content?.via) &&
          event.content.via.length > 0
            ? [{ spaceId: event.state_key, canonical: event.content.canonical === true }]
            : []
        );
      })
      .catch((error: unknown) => {
        console.debug('[sable room] space parents unavailable', error);
      });
  });
</script>

{#if entries.length > 0}
  <SettingsRow title={$i18n.t('room.spacesTitle')} description={$i18n.t('room.spacesHint')}>
    <ul class="spaces">
      {#each entries as entry (entry.spaceId)}
        <li>
          <span class="name">{roomList.labelFor(entry.spaceId)}</span>
          <span class="kind">
            {entry.canonical ? $i18n.t('room.spaceCanonical') : $i18n.t('room.spaceOther')}
          </span>
        </li>
      {/each}
    </ul>
  </SettingsRow>
{/if}

<style>
  .spaces {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  li {
    align-items: baseline;
    display: flex;
    gap: var(--space-200);
    justify-content: space-between;
    min-width: 0;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
  }
</style>
