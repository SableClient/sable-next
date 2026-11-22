<script lang="ts">
  import { page } from '$app/state';

  import JoinBeforeNavigate from '#lib/features/room/discovery/JoinBeforeNavigate.svelte';
  import SpaceRules from '#lib/features/room/spaces/SpaceRules.svelte';
  import { i18n } from '#lib/i18n.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';

  const roomList = useRoomList();
  let spaceId = $derived(page.params.spaceId ?? '');
  let space = $derived(findRoomByPathId(roomList.rooms, spaceId) ?? null);
</script>

<PageTitle
  title={space?.name
    ? i18n.t('room.rulesHeading', { name: space.name })
    : i18n.t('room.rulesTitle')}
/>

<main class="rules-page">
  <div class="rules-column">
    {#if (space !== null && space.state === 'joined') || !roomList.settled}
      <SpaceRules {space} />
    {:else}
      <JoinBeforeNavigate
        roomId={spaceId}
        via={page.url.searchParams.getAll('via')}
        membership={space?.state}
      />
    {/if}
  </div>
</main>

<style>
  .rules-page {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }

  .rules-column {
    margin: 0 auto;
    max-width: 52rem;
    padding: var(--page-gutter);
    width: 100%;
  }
</style>
