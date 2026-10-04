<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { bannerChanges, readRoomBanner } from '#lib/features/room/room-banner.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();

  let banner = $state<string | null>(null);

  $effect(() => {
    const target = roomId;
    void bannerChanges.version;
    let current = true;
    void readRoomBanner(core, target).then((next) => {
      if (current) banner = next;
    });
    return () => {
      current = false;
      banner = null;
    };
  });
</script>

{#if banner && preferences.showRoomBanners}
  <div class="room-banner-strip" style:height={`${preferences.roomBannerHeight}px`}>
    <MediaImage source={banner} alt="" width={1280} height={380} class="room-banner-strip-image" />
  </div>
{/if}

<style>
  .room-banner-strip {
    flex: none;
    overflow: hidden;
  }

  .room-banner-strip :global(.room-banner-strip-image),
  .room-banner-strip :global(img) {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }
</style>
