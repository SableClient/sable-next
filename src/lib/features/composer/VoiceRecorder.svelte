<script lang="ts">
  import StopIcon from 'phosphor-svelte/lib/StopIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { markVoiceRecording } from '#lib/core/attachment-info.js';
  import { i18n } from '#lib/i18n.js';
  import { formatClockDuration } from '#lib/ui/clock-duration.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { downsampleWaveform } from './voice-waveform';
  import { extensionForMimeType, loadVoiceRecorder } from './voice-recorder-support';
  import type { VoiceMediaRecorder } from './voice-recorder-support';

  interface Props {
    onSend: (file: File) => void;
    onCancel: () => void;
    onDenied?: () => void;
  }

  let { onSend, onCancel, onDenied }: Props = $props();

  type Status = 'requesting' | 'recording' | 'stopping' | 'denied' | 'unavailable';

  let status = $state<Status>('requesting');
  let elapsedMs = $state(0);
  let level = $state(0);
  let announcement = $state('');

  let stream: MediaStream | null = null;
  let recorder: VoiceMediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let chunks: Blob[] = [];
  const samples: number[] = [];
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let disposeRecorder: (() => void) | undefined;

  function releaseStream(): void {
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    stream = null;
  }

  function teardown(): void {
    if (recorder) {
      recorder.onstart = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.ondataavailable = null;
    }
    disposeRecorder?.();
    disposeRecorder = undefined;
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

  async function start(cancelled: () => boolean): Promise<void> {
    let createRecorder;
    try {
      createRecorder = await loadVoiceRecorder();
    } catch (cause) {
      console.debug('[sable composer] voice encoder unavailable', cause);
      if (cancelled()) return;
      status = 'unavailable';
      onDenied?.();
      return;
    }
    if (cancelled()) return;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      if (cancelled()) return;
      console.debug('[sable composer] microphone permission denied', cause);
      status = 'denied';
      onDenied?.();
      return;
    }
    if (cancelled()) {
      releaseStream();
      return;
    }

    try {
      audioContext = new AudioContext({ latencyHint: 'playback', sampleRate: 48_000 });
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const session = createRecorder(stream, audioContext);
      recorder = session.recorder;
      disposeRecorder = session.dispose;
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstart = () => {
        startedAt = Date.now();
        status = 'recording';
        announcement = $i18n.t('composer.voiceStarted');
        sampleTimer = setInterval(sampleLevel, 100);
      };
      recorder.onerror = () => {
        teardown();
        status = 'unavailable';
        onDenied?.();
      };
      recorder.start();
    } catch (cause) {
      console.debug('[sable composer] voice recording unavailable', cause);
      teardown();
      status = 'unavailable';
      onDenied?.();
    }
  }

  $effect(() => {
    let cancelled = false;
    void start(() => cancelled);
    return () => {
      cancelled = true;
      teardown();
    };
  });

  function finish(send: boolean): void {
    if (!recorder || status !== 'recording') {
      onCancel();
      return;
    }

    const activeRecorder = recorder;
    status = 'stopping';
    if (!send) {
      announcement = $i18n.t('composer.voiceCancelled');
      teardown();
      onCancel();
      return;
    }
    const finalMime = activeRecorder.mimeType.split(';')[0].trim();
    const waveform = downsampleWaveform(samples);
    const durationMs = Math.max(1, Date.now() - startedAt);

    activeRecorder.onstop = () => {
      teardown();
      const blob = new Blob(chunks, { type: finalMime });
      const extension = extensionForMimeType(finalMime);
      const file = new File([blob], `voice-message-${String(Date.now())}.${extension}`, {
        type: finalMime,
      });
      markVoiceRecording(file, waveform, durationMs);
      onSend(file);
    };
    announcement = $i18n.t('composer.voiceStopped');
    activeRecorder.stop();
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
    <span class="voice-time">{formatClockDuration(Math.floor(elapsedMs / 1000))}</span>
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
  <p class="screen-reader-only" aria-live="polite">{announcement}</p>
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
    color: var(--crit-on-container);
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
    background: var(--crit-main);
    border-radius: var(--radius-pill);
    flex: none;
    height: 0.5rem;
    width: 0.5rem;
  }

  .voice-level {
    background: var(--primary-main);
    border-radius: var(--radius-pill);
    flex: 1;
    height: 1.5rem;
    transform-origin: center;
  }

  .voice-time {
    color: var(--surface-var-on-container);
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
    color: var(--crit-main);
  }

  @media (prefers-reduced-motion: no-preference) {
    .voice-level {
      transition: transform var(--duration-micro) linear;
    }
  }
</style>
