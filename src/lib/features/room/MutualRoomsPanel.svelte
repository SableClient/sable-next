<script lang="ts">
  import type { MutualRoomView } from '#src/generated/MutualRoomView';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    kind: 'rooms' | 'spaces';
    rooms: readonly MutualRoomView[];
    expanded: boolean;
    onOpenRoom: (roomId: string) => void;
    onExpand: () => void;
    onBack: () => void;
  }

  let { kind, rooms, expanded, onOpenRoom, onExpand, onBack }: Props = $props();
  let shown = $derived(expanded ? rooms : rooms.slice(0, 5));
  let title = $derived(
    $i18n.t(kind === 'spaces' ? 'timeline.profileMutualSpaces' : 'timeline.profileMutualRooms', {
      count: rooms.length,
    })
  );
</script>

<p class="profile-rooms-title">{title}</p>
<ul class="profile-rooms">
  {#each shown as room (room.room_id)}
    <li>
      <Button
        class="profile-room-button"
        variant="ghost"
        size="small"
        onclick={() => {
          onOpenRoom(room.room_id);
        }}
      >
        <span class="profile-rooms-monogram" aria-hidden="true">
          {(room.name ?? room.room_id).replace(/^[#!]/, '').slice(0, 1).toUpperCase()}
        </span>
        {room.name ?? room.room_id}
      </Button>
    </li>
  {/each}
</ul>
<div class="profile-rooms-links">
  {#if rooms.length > shown.length}
    <Button class="profile-rooms-link" variant="ghost" size="small" onclick={onExpand}>
      {$i18n.t(kind === 'spaces' ? 'timeline.profileSeeAllSpaces' : 'timeline.profileSeeAllRooms', {
        count: rooms.length,
      })}
    </Button>
  {/if}
  <Button class="profile-rooms-link" variant="ghost" size="small" onclick={onBack}>
    {$i18n.t('timeline.profileBackToProfile')}
  </Button>
</div>

<style>
  .profile-rooms-title {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    margin: 0 0 var(--space-1);
  }

  .profile-rooms {
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.125rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  :global(.profile-room-button) {
    justify-content: flex-start;
    text-align: left;
    width: 100%;
  }

  .profile-rooms-monogram {
    align-items: center;
    background: var(--sable-primary-container);
    border-radius: var(--radius-pill);
    color: var(--sable-primary-on-container);
    display: inline-flex;
    flex: none;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: 1.5rem;
    justify-content: center;
    width: 1.5rem;
  }

  .profile-rooms-links {
    display: grid;
    gap: 0.25rem;
    justify-items: start;
    margin-top: var(--space-1);
  }

  :global(.profile-rooms-link) {
    color: var(--sable-primary-main);
    font-weight: var(--font-weight-medium);
    justify-content: flex-start;
    padding-inline: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }
</style>
