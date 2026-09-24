<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import {
    MAX_PARTICIPANT_VOLUME,
    participantVolume,
    setParticipantVolume,
  } from './participant-volumes.svelte.js';

  interface Props {
    open?: boolean;
    anchor: HTMLElement | null;
    userId: string;
    name: string;
    onVolumeChange?: (userId: string, volume: number) => void;
  }

  let { open = $bindable(false), anchor, userId, name, onVolumeChange }: Props = $props();

  let volume = $derived(participantVolume(userId));

  function apply(next: number): void {
    setParticipantVolume(userId, next);
    onVolumeChange?.(userId, next);
  }
</script>

<ResponsivePopover
  bind:open
  {anchor}
  side="right"
  align="center"
  class="call-volume-popover"
  label={$i18n.t('call.participantVolume', { name })}
  closeLabel={$i18n.t('call.dismiss')}
>
  <div class="volume">
    <p>{$i18n.t('call.participantVolume', { name })}</p>
    <div class="row">
      <Slider
        min={0}
        max={MAX_PARTICIPANT_VOLUME}
        step={0.05}
        label={$i18n.t('call.participantVolume', { name })}
        value={volume}
        oninput={apply}
      />
      <span class="reading">{Math.round(volume * 100)}%</span>
    </div>
  </div>
</ResponsivePopover>

<style>
  .volume {
    display: grid;
    gap: var(--space-150);
    inline-size: min(16rem, calc(100vw - 2rem));
    padding: var(--space-200) var(--space-300);
  }

  .volume p {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
  }

  .row {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .reading {
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    inline-size: 2.5rem;
    text-align: end;
  }
</style>
