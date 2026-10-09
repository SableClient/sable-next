<script lang="ts">
  import { untrack } from 'svelte';
  import type { Room as LivekitRoom } from 'livekit-client';
  import { Track } from 'livekit-client';

  import { i18n } from '#lib/i18n.js';

  import {
    averageBitrate,
    bitrateWindow,
    readVideoStats,
    type VideoStats,
    type VideoStatsSample,
  } from './call-stats';
  import { ignoreError } from './call-transport';

  interface Props {
    room: LivekitRoom;
    identity: string;
    local: boolean;
    trackId: string;
  }

  let { room, identity, local, trackId }: Props = $props();

  const STATS_INTERVAL_MS = 1000;

  let stats = $state<VideoStats>();

  $effect(() => {
    void trackId;
    const owner = untrack(() =>
      local ? room.localParticipant : room.remoteParticipants.get(identity)
    );
    const track = owner?.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (!track) return;
    let samples: VideoStatsSample[] = [];
    let stopped = false;
    const poll = async () => {
      const report = await track.getRTCStatsReport();
      if (stopped || !report) return;
      const read = readVideoStats(report);
      samples = read ? bitrateWindow(samples, read.sample) : [];
      stats = read && { ...read.stats, bitrate: averageBitrate(samples) };
    };
    void poll().catch(ignoreError);
    const timer = setInterval(() => void poll().catch(ignoreError), STATS_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      stats = undefined;
    };
  });

  function bitrate(bits: number): string {
    const kbps = bits / 1000;
    return kbps >= 1000
      ? $i18n.t('call.statsMbps', { value: Math.round(kbps / 100) / 10 })
      : $i18n.t('call.statsKbps', { value: Math.round(kbps) });
  }

  function implementation(name: string, powerEfficient: boolean | undefined): string {
    if (powerEfficient === undefined) return name;
    return $i18n.t(powerEfficient ? 'call.statsHardware' : 'call.statsSoftware', { name });
  }
</script>

{#if stats}
  <dl class="stats" aria-label={$i18n.t('call.statsLabel')}>
    {#if stats.width !== undefined && stats.height !== undefined}
      <dt>{$i18n.t('call.statsResolution')}</dt>
      <dd>{stats.width}×{stats.height}</dd>
    {/if}
    {#if stats.fps !== undefined}
      <dt>{$i18n.t('call.statsFramerate')}</dt>
      <dd>{$i18n.t('call.statsFps', { value: Math.round(stats.fps) })}</dd>
    {/if}
    {#if stats.codec}
      <dt>{$i18n.t('call.statsCodec')}</dt>
      <dd>{stats.codec}</dd>
    {/if}
    {#if stats.implementation}
      <dt>{$i18n.t(stats.direction === 'send' ? 'call.statsEncoder' : 'call.statsDecoder')}</dt>
      <dd>{implementation(stats.implementation, stats.powerEfficient)}</dd>
    {/if}
    {#if stats.bitrate !== undefined}
      <dt>{$i18n.t('call.statsBitrate')}</dt>
      <dd>{bitrate(stats.bitrate)}</dd>
    {/if}
  </dl>
{/if}

<style>
  .stats {
    backdrop-filter: blur(0.5rem);
    background: var(--tile-scrim);
    border-radius: var(--radii-300);
    color: var(--picker-white);
    column-gap: var(--space-200);
    display: grid;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    grid-template-columns: auto auto;
    inset: auto var(--space-200) var(--space-200) auto;
    margin: 0;
    max-inline-size: calc(100% - var(--space-400));
    padding: var(--space-100) var(--space-200);
    pointer-events: none;
    position: absolute;
  }

  dt {
    opacity: var(--opacity-secondary);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
