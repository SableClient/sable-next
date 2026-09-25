<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    name: string;
    userId: string;
    avatar: string | null;
    muted?: boolean;
    speaking?: boolean;
    stream?: MediaStream;
    note?: string;
  }

  let { name, userId, avatar, muted = false, speaking = false, stream, note }: Props = $props();

  function attachStream(node: HTMLVideoElement) {
    node.srcObject = stream ?? null;
    return () => {
      node.srcObject = null;
    };
  }
</script>

<li class="tile" class:video-on={stream !== undefined} class:speaking>
  {#if stream}
    <video
      class="video"
      autoplay
      muted
      playsinline
      aria-label={$i18n.t('call.prescreenPreview')}
      {@attach attachStream}
    ></video>
  {:else}
    <div class="placeholder">
      <Avatar src={avatar} {name} id={userId} size="large" />
      {#if note}<p class="note">{note}</p>{/if}
    </div>
  {/if}
  <span class="tag">
    {#if muted}
      <span class="muted" title={$i18n.t('call.muted')}>
        <MicrophoneSlashIcon aria-hidden="true" weight="fill" />
        <span class="screen-reader-only">{$i18n.t('call.muted')}</span>
      </span>
    {/if}
    <span class="name">{name}</span>
  </span>
</li>

<style>
  .tile {
    background: var(--surface-var-container);
    border-radius: var(--radii-400);
    box-sizing: border-box;
    container-type: size;
    overflow: hidden;
    position: relative;
  }

  .tile.video-on {
    background: var(--picker-black);
  }

  .video {
    block-size: 100%;
    display: block;
    inline-size: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .placeholder {
    align-items: center;
    block-size: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    inline-size: 100%;
    justify-content: center;
  }

  .placeholder :global(.avatar-root) {
    --avatar-size: clamp(2.5rem, 36cqmin, 6rem);

    transition: box-shadow var(--motion-normal) var(--motion-easing-emphasized);
  }

  .speaking .placeholder :global(.avatar-root) {
    box-shadow:
      0 0 0 0.1875rem var(--surface-var-container),
      0 0 0 0.375rem var(--success-main);
  }

  .tile::after {
    border-radius: inherit;
    box-shadow: inset 0 0 0 0 var(--success-main);
    content: '';
    inset: 0;
    pointer-events: none;
    position: absolute;
    transition: box-shadow var(--motion-normal) var(--motion-easing-emphasized);
  }

  .tile.speaking.video-on::after {
    box-shadow:
      inset 0 0 0 0.1875rem var(--success-main),
      inset 0 0 0 0.3125rem color-mix(in srgb, var(--success-main) 30%, transparent);
  }

  .note {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    text-align: center;
  }

  .tag {
    align-items: center;
    backdrop-filter: blur(0.5rem);
    background: color-mix(in srgb, var(--picker-black) 62%, transparent);
    border-radius: var(--radii-300);
    box-sizing: border-box;
    color: var(--picker-white);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    inset: auto auto var(--space-200) var(--space-200);
    max-inline-size: calc(100% - var(--space-400));
    padding: var(--space-050) var(--space-200);
    position: absolute;
  }

  .tag :global(svg) {
    flex: none;
    height: 0.875rem;
    width: 0.875rem;
  }

  .muted {
    color: var(--crit-main);
    display: inline-flex;
    flex: none;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
