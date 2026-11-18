<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    roomIds: readonly string[];
    spaces: ReadonlyMap<string, RoomListItemView>;
  }

  let { roomIds, spaces }: Props = $props();
</script>

<span class="folder-tiles" aria-hidden="true">
  {#each roomIds as roomId (roomId)}
    {@const space = spaces.get(roomId)}
    <Avatar
      class="folder-tile"
      id={roomId}
      src={space?.display_avatar_url}
      name={space?.name ?? roomId}
      size="small"
      uniform
    />
  {/each}
</span>

<style>
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
</style>
