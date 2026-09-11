<script lang="ts">
  import { untrack } from 'svelte';
  import type { TimelineItemContentView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import TimelineLocation from './TimelineLocation.svelte';
  import { formatTime } from './timeline-format.js';

  let { location }: { location: Extract<TimelineItemContentView, { kind: 'live_location' }> } =
    $props();
  let now = $state(Date.now());
  let live = $derived(location.live && location.expires_at > now);
  let updated = $derived(location.updated_at === null ? null : new Date(location.updated_at));

  $effect(() => {
    const expiresAt = location.expires_at;
    const enabled = location.live;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      now = Date.now();
      if (enabled && expiresAt > now)
        timer = setTimeout(update, Math.min(expiresAt - now, 86_400_000));
    };
    untrack(update);
    return () => clearTimeout(timer);
  });
</script>

<p class="status">{$i18n.t(live ? 'timeline.liveLocationActive' : 'timeline.liveLocationEnded')}</p>
<TimelineLocation
  body={location.body || $i18n.t('timeline.liveLocation')}
  latitude={location.latitude}
  longitude={location.longitude}
/>
{#if updated && Number.isFinite(updated.getTime())}
  <time class="status" datetime={updated.toISOString()}>
    {$i18n.t('timeline.liveLocationUpdated', { time: formatTime(updated.getTime()) })}
  </time>
{/if}

<style>
  .status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
