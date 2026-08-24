<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';

  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { CallMedia } from './call-session.svelte.js';

  interface Props {
    media: CallMedia;
    joining: boolean;
    onChange: (media: CallMedia) => void;
    onJoin: () => void;
    onCancel: () => void;
  }

  let { media, joining, onChange, onJoin, onCancel }: Props = $props();

  let stream = $state.raw<MediaStream | undefined>(undefined);
  let wantsCamera = $derived(media.camera);

  $effect(() => {
    if (!wantsCamera) {
      stream = undefined;
      return;
    }

    let cancelled = false;
    let opened: MediaStream | undefined;

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((next) => {
        if (cancelled) {
          for (const track of next.getTracks()) track.stop();
          return;
        }
        opened = next;
        stream = next;
      })
      .catch(() => {
        if (!cancelled) stream = undefined;
      });

    return () => {
      cancelled = true;
      for (const track of opened?.getTracks() ?? []) track.stop();
    };
  });

  function attachPreview(node: HTMLVideoElement) {
    node.srcObject = stream ?? null;
    return () => {
      node.srcObject = null;
    };
  }
</script>

<div class="prescreen">
  <h2>{$i18n.t('call.prescreenTitle')}</h2>

  <div class="preview">
    {#if wantsCamera && stream}
      <video
        class="video"
        autoplay
        muted
        playsinline
        aria-label={$i18n.t('call.prescreenPreview')}
        {@attach attachPreview}
      ></video>
    {:else}
      <p class="camera-off">{$i18n.t('call.prescreenNoCamera')}</p>
    {/if}
  </div>

  <div class="toggles">
    <IconButton
      variant="ghost"
      label={media.microphone ? $i18n.t('call.microphoneOn') : $i18n.t('call.microphoneOff')}
      aria-pressed={media.microphone}
      onclick={() => {
        onChange({ ...media, microphone: !media.microphone });
      }}
    >
      {#if media.microphone}
        <MicrophoneIcon />
      {:else}
        <MicrophoneSlashIcon />
      {/if}
    </IconButton>

    <IconButton
      variant="ghost"
      label={media.camera ? $i18n.t('call.cameraOn') : $i18n.t('call.cameraOff')}
      aria-pressed={media.camera}
      onclick={() => {
        onChange({ ...media, camera: !media.camera });
      }}
    >
      {#if media.camera}
        <VideoCameraIcon />
      {:else}
        <VideoCameraSlashIcon />
      {/if}
    </IconButton>
  </div>

  <div class="actions">
    <Button variant="ghost" onclick={onCancel}>{$i18n.t('call.cancel')}</Button>
    <Button variant="primary" disabled={joining} onclick={onJoin}>
      {joining ? $i18n.t('call.joining') : $i18n.t('call.join')}
    </Button>
  </div>
</div>

<style>
  .prescreen {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-h4);
    line-height: var(--line-height-h4);
    margin: 0;
  }

  .preview {
    align-items: center;
    aspect-ratio: 4 / 3;
    background: var(--sable-surface-var-container);
    border-radius: var(--radii-400);
    display: flex;
    justify-content: center;
    overflow: hidden;
  }

  .video {
    block-size: 100%;
    inline-size: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .camera-off {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .toggles {
    display: flex;
    gap: var(--space-200);
    justify-content: center;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
