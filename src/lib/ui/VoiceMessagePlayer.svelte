<script lang="ts">
  import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

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

  function formatTime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(minutes)}:${String(secs).padStart(2, '0')}`;
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
    background: var(--sable-surface-var-on-container);
    border-radius: var(--radius-pill);
    flex: 1;
    min-height: 2px;
  }

  .voice-bar.played {
    background: var(--sable-primary-main);
  }

  .voice-scrub {
    accent-color: var(--sable-primary-main);
    display: block;
    margin: 0;
    width: 100%;
  }

  .voice-time {
    color: var(--sable-surface-var-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }
</style>
