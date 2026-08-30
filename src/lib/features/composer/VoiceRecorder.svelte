<script lang="ts">
  import StopIcon from 'phosphor-svelte/lib/StopIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { markVoiceRecording } from '#lib/core/attachment-info.js';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { downsampleWaveform } from './voice-waveform';
  import { extensionForMimeType, pickRecordingMimeType } from './voice-recorder-support';

  interface Props {
    onSend: (file: File) => void;
    onCancel: () => void;
    onDenied?: () => void;
  }

  let { onSend, onCancel, onDenied }: Props = $props();

  type Status = 'requesting' | 'recording' | 'denied' | 'unavailable';

  let status = $state<Status>('requesting');
  let elapsedMs = $state(0);
  let level = $state(0);
  let announcement = $state('');

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let chunks: Blob[] = [];
  const samples: number[] = [];
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let mimeType = '';

  function releaseStream(): void {
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
  }

  function teardown(): void {
    if (sampleTimer !== undefined) clearInterval(sampleTimer);
    sampleTimer = undefined;
    analyser = null;
    if (audioContext && audioContext.state !== 'closed') void audioContext.close();
    audioContext = null;
    releaseStream();
    recorder = null;
  }

  function sampleLevel(): void {
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    level = Math.min(1, rms * 4);
    samples.push(rms);
    elapsedMs = Date.now() - startedAt;
  }

  async function start(): Promise<void> {
    const picked = pickRecordingMimeType();
    if (picked === null) {
      status = 'unavailable';
      onDenied?.();
      return;
    }
    mimeType = picked;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      console.debug('[sable composer] microphone permission denied', cause);
      status = 'denied';
      onDenied?.();
      return;
    }

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    recorder = new MediaRecorder(stream, { mimeType });
    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();

    startedAt = Date.now();
    status = 'recording';
    announcement = $i18n.t('composer.voiceStarted');
    sampleTimer = setInterval(sampleLevel, 100);
  }

  $effect(() => {
    void start();
    return () => {
      teardown();
    };
  });

  function finish(send: boolean): void {
    if (!recorder || status !== 'recording') {
      onCancel();
      return;
    }

    const activeRecorder = recorder;
    const finalMime = mimeType;
    const waveform = downsampleWaveform(samples);

    activeRecorder.onstop = () => {
      if (!send) {
        onCancel();
        return;
      }
      const blob = new Blob(chunks, { type: finalMime });
      const extension = extensionForMimeType(finalMime);
      const file = new File([blob], `voice-message-${String(Date.now())}.${extension}`, {
        type: finalMime,
      });
      markVoiceRecording(file, waveform);
      onSend(file);
    };
    announcement = send ? $i18n.t('composer.voiceStopped') : $i18n.t('composer.voiceCancelled');
    activeRecorder.stop();
  }

  function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
  }
</script>

<div class="voice-recorder" role="group" aria-label={$i18n.t('composer.voiceRecording')}>
  {#if status === 'denied' || status === 'unavailable'}
    <p class="voice-message">
      {status === 'denied'
        ? $i18n.t('composer.voicePermissionDenied')
        : $i18n.t('composer.voiceUnavailable')}
    </p>
    <IconButton
      variant="ghost"
      size="small"
      class="voice-close"
      label={$i18n.t('composer.voiceCancel')}
      onclick={onCancel}
    >
      <XIcon />
    </IconButton>
  {:else}
    <IconButton
      variant="ghost"
      size="small"
      class="voice-cancel"
      disabled={status !== 'recording'}
      label={$i18n.t('composer.voiceCancel')}
      onclick={() => {
        finish(false);
      }}
    >
      <XIcon />
    </IconButton>
    <div class="voice-meter" aria-hidden="true">
      <span class="voice-dot"></span>
      <span class="voice-level" style:transform={`scaleY(${String(0.15 + level * 0.85)})`}></span>
    </div>
    <span class="voice-time">{formatElapsed(elapsedMs)}</span>
    <IconButton
      variant="ghost"
      size="small"
      class="voice-send"
      disabled={status !== 'recording'}
      label={$i18n.t('composer.voiceSend')}
      onclick={() => {
        finish(true);
      }}
    >
      <StopIcon weight="fill" />
    </IconButton>
  {/if}
  <p class="sr-only" aria-live="polite">{announcement}</p>
</div>

<style>
  .voice-recorder {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .voice-message {
    color: var(--sable-crit-on-container);
    flex: 1;
    font-size: var(--font-size-small);
    margin: 0;
  }

  .voice-meter {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--space-100);
    min-height: var(--control-height-small);
  }

  .voice-dot {
    background: var(--sable-crit-main);
    border-radius: var(--radius-pill);
    flex: none;
    height: 0.5rem;
    width: 0.5rem;
  }

  .voice-level {
    background: var(--sable-primary-main);
    border-radius: var(--radius-pill);
    flex: 1;
    height: 1.5rem;
    transform-origin: center;
  }

  .voice-time {
    color: var(--sable-surface-var-on-container);
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  :global(.voice-cancel),
  :global(.voice-send),
  :global(.voice-close) {
    border-radius: var(--radius);
    flex: 0 0 auto;
    height: var(--target);
    min-height: var(--target);
    position: relative;
    width: var(--target);
  }

  :global(.voice-cancel)::after,
  :global(.voice-send)::after,
  :global(.voice-close)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.voice-send) {
    color: var(--sable-crit-main);
  }

  .sr-only {
    clip-path: inset(50%);
    height: 1px;
    margin: 0;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .voice-level {
      transition: transform 80ms linear;
    }
  }
</style>
