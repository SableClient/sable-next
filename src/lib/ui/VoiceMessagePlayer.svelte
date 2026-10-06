<script lang="ts">
  import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerLowIcon from 'phosphor-svelte/lib/SpeakerLowIcon';
  import SpeakerXIcon from 'phosphor-svelte/lib/SpeakerXIcon';

  import { i18n } from '#lib/i18n.js';
  import { formatClockDuration } from '#lib/ui/clock-duration.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import { voicePlayback } from '#lib/ui/voice-playback.svelte.js';

  const SCRUB_RESOLUTION = 1000;

  interface Props {
    url: string;
    body: string;
    durationMs: number | null;
    waveform: number[];
  }

  let { url, body, durationMs, waveform }: Props = $props();

  let audio: HTMLAudioElement | undefined = $state();
  let playing = $state(false);
  let currentTime = $state(0);
  let measuredDuration = $state<number | null>(null);

  let duration = $derived(measuredDuration ?? (durationMs !== null ? durationMs / 1000 : 0));
  let progress = $derived(duration > 0 ? Math.min(1, currentTime / duration) : 0);
  let activeBars = $derived(Math.round(progress * waveform.length));

  function toggle(): void {
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play();
  }

  function seek(event: Event): void {
    if (!audio) return;
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const next = (Number(input.value) / SCRUB_RESOLUTION) * duration;
    audio.currentTime = next;
    currentTime = next;
  }

  function setVolume(event: Event): void {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) voicePlayback.setVolume(Number(input.value));
  }

  $effect(() => {
    if (!audio) return;
    audio.playbackRate = voicePlayback.speed;
    audio.volume = voicePlayback.volume;
  });

  function formatTime(seconds: number): string {
    return formatClockDuration(Math.max(0, Math.round(seconds)));
  }
</script>

<div class="voice-message-player">
  <IconButton
    variant="ghost"
    size="small"
    class="voice-play"
    label={playing ? $i18n.t('timeline.pauseVoiceMessage') : $i18n.t('timeline.playVoiceMessage')}
    onclick={toggle}
  >
    {#if playing}
      <PauseIcon weight="fill" />
    {:else}
      <PlayIcon weight="fill" />
    {/if}
  </IconButton>
  <div class="voice-track">
    <div class="voice-waveform" aria-hidden="true">
      {#each waveform as level, index (index)}
        <span
          class="voice-bar"
          class:played={index < activeBars}
          style:height={`${String(Math.max(0.12, level) * 100)}%`}
        ></span>
      {/each}
    </div>
    <input
      class="voice-scrub"
      type="range"
      min="0"
      max={SCRUB_RESOLUTION}
      value={Math.round(progress * SCRUB_RESOLUTION)}
      oninput={seek}
      aria-label={$i18n.t('timeline.voiceMessagePosition')}
      aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
    />
  </div>
  <span class="voice-time">{formatTime(currentTime)}</span>
  <Pill
    class="voice-speed"
    aria-label={$i18n.t('timeline.voiceMessageSpeed', { speed: voicePlayback.speed })}
    onclick={voicePlayback.cycleSpeed}
  >
    {voicePlayback.speed}×
  </Pill>
  <label class="voice-volume">
    {#if voicePlayback.volume === 0}
      <SpeakerXIcon />
    {:else if voicePlayback.volume < 0.5}
      <SpeakerLowIcon />
    {:else}
      <SpeakerHighIcon />
    {/if}
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={voicePlayback.volume}
      oninput={setVolume}
      aria-label={$i18n.t('timeline.voiceMessageVolume')}
    />
  </label>
  <audio
    bind:this={audio}
    src={url}
    preload="metadata"
    onplay={() => {
      playing = true;
    }}
    onpause={() => {
      playing = false;
    }}
    onended={() => {
      playing = false;
      currentTime = 0;
    }}
    ontimeupdate={() => {
      if (audio) currentTime = audio.currentTime;
    }}
    onloadedmetadata={() => {
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        measuredDuration = audio.duration;
      }
    }}
  >
    {body}
  </audio>
</div>

<style>
  .voice-message-player {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    margin-top: var(--space-100);
    min-height: var(--control-height-medium);
    width: 100%;
  }

  .voice-track {
    flex: 1;
    min-width: 0;
    position: relative;
  }

  .voice-waveform {
    align-items: flex-end;
    display: flex;
    gap: var(--space-050);
    height: 1.75rem;
  }

  .voice-bar {
    background: var(--surface-var-on-container);
    border-radius: var(--radius-pill);
    flex: 1;
    min-height: 2px;
  }

  .voice-bar.played {
    background: var(--primary-main);
  }

  .voice-scrub {
    accent-color: var(--primary-main);
    display: block;
    margin: 0;
    width: 100%;
  }

  .voice-message-player :global(.voice-speed) {
    font-variant-numeric: tabular-nums;
    min-width: 2.75rem;
  }

  .voice-volume {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  .voice-volume input {
    accent-color: var(--primary-main);
    margin: 0;
    min-height: var(--control-height-small);
    width: 4rem;
  }

  @media (pointer: coarse) {
    .voice-volume {
      display: none;
    }
  }

  .voice-time {
    color: var(--surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }
</style>
