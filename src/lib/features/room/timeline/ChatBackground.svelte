<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { loadRoomBackground, roomBackground } from '#lib/rooms/chat-background.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { isHexColor } from '#lib/ui/hex-color.js';
  import { holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';

  let { roomId }: { roomId?: string } = $props();

  const core = useCoreClient();

  let own = $derived(roomId === undefined ? undefined : roomBackground(core, roomId));
  // A room with a background of its own shows that one whole, not a mix with the general one.
  let choice = $derived(
    own && (own.image !== '' || own.color !== '')
      ? own
      : { image: preferences.chatBackgroundImage, color: preferences.chatBackgroundColor }
  );
  // Waiting for the room's own choice keeps the general one from flashing first.
  let waiting = $derived(roomId !== undefined && own === undefined);
  let image = $derived(waiting ? '' : choice.image);
  let color = $derived(!waiting && isHexColor(choice.color) ? choice.color : null);
  let url = $state<string | null>(null);

  $effect(() => {
    if (roomId !== undefined) void loadRoomBackground(core, roomId);
  });

  $effect(() => {
    const source = image;
    url = null;
    if (source === '') return;
    const release = holdMediaUrl(core, source, 0, 0);
    let current = true;
    loadMediaUrl(core, source, 0, 0)
      .then((loaded) => {
        if (current) url = loaded;
      })
      .catch((error: unknown) => {
        console.debug('[sable timeline] chat background unavailable', error);
      });
    return () => {
      current = false;
      release();
    };
  });
</script>

{#if color !== null || url !== null}
  <div
    class={['chat-background', { pictured: url !== null }]}
    style:background-color={color}
    style:background-image={url === null ? null : `url("${url}")`}
    aria-hidden="true"
  ></div>
{/if}

<style>
  .chat-background {
    background-position: center;
    background-size: cover;
    inset: 0;
    pointer-events: none;
    position: absolute;
    z-index: -1;
  }

  /* Keeps message text readable over a picture in either theme. */
  .chat-background.pictured::after {
    background: color-mix(in srgb, var(--surface-container) 70%, transparent);
    content: '';
    inset: 0;
    position: absolute;
  }
</style>
