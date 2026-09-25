<script lang="ts">
  import { onMount } from 'svelte';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    onScan: (data: Uint8Array) => void;
  }

  let { onScan }: Props = $props();

  const SCAN_INTERVAL_MS = 200;
  const MAX_FRAME_EDGE = 720;
  const HEADER = [0x4d, 0x41, 0x54, 0x52, 0x49, 0x58];

  let video = $state<HTMLVideoElement>();
  let failed = $state(false);

  function isVerificationCode(data: number[]): boolean {
    return HEADER.every((byte, index) => data[index] === byte);
  }

  onMount(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    async function start(): Promise<void> {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'environment' },
        });
      } catch {
        failed = true;
        return;
      }
      if (stopped || !video || !context) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      const { default: jsQR } = await import('jsqr');
      const element = video;
      element.srcObject = stream;
      await element.play().catch(() => undefined);

      timer = setInterval(() => {
        if (!element.videoWidth) return;
        const scale = Math.min(
          1,
          MAX_FRAME_EDGE / Math.max(element.videoWidth, element.videoHeight)
        );
        canvas.width = Math.round(element.videoWidth * scale);
        canvas.height = Math.round(element.videoHeight * scale);
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: 'dontInvert',
        });
        if (!found || !isVerificationCode(found.binaryData)) return;
        clearInterval(timer);
        onScan(new Uint8Array(found.binaryData));
      }, SCAN_INTERVAL_MS);
    }

    void start();

    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  });
</script>

{#if failed}
  <p class="verification-scanner-failed" role="alert">{$i18n.t('settings.cameraUnavailable')}</p>
{:else}
  <div class="verification-scanner">
    <video bind:this={video} muted playsinline aria-label={$i18n.t('settings.scanningQr')}></video>
  </div>
  <p class="verification-scanner-hint" role="status">{$i18n.t('settings.scanningQr')}</p>
{/if}

<style>
  .verification-scanner {
    aspect-ratio: 1;
    background: var(--media-scrim-solid);
    border-radius: var(--radii-400);
    overflow: hidden;
    width: min(16rem, 100%);
  }

  .verification-scanner video {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .verification-scanner-hint,
  .verification-scanner-failed {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
