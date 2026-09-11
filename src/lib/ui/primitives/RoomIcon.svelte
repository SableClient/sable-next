<script lang="ts">
  import {
    roomIconComponent,
    roomIconOverlay,
    roomIconOverlayComponent,
    type RoomIconShape,
  } from './room-icon.js';

  type Props = RoomIconShape & {
    weight?: 'regular' | 'fill';
  };

  let { isSpace = false, isVoice = false, joinRule = null, weight = 'regular' }: Props = $props();

  let room = $derived({ isSpace, isVoice, joinRule });
  let overlay = $derived(roomIconOverlay(room));
  let Glyph = $derived(roomIconComponent(room));
  let Badge = $derived(overlay === undefined ? undefined : roomIconOverlayComponent(overlay));
</script>

<span class="room-icon-root">
  {#if Badge && overlay}
    <span class="room-icon-composite">
      <Glyph {weight} />
      <span class={['room-icon-badge', overlay]} aria-hidden="true">
        <span class="room-icon-badge-glyph"><Badge size="100%" weight="regular" /></span>
      </span>
    </span>
  {:else}
    <Glyph {weight} />
  {/if}
</span>

<style>
  .room-icon-root {
    align-items: center;
    display: flex;
    height: 100%;
    justify-content: center;
    line-height: 0;
    overflow: visible;
    width: 100%;
  }

  .room-icon-composite {
    align-items: center;
    display: inline-flex;
    flex-shrink: 0;
    justify-content: center;
    line-height: 0;
    overflow: visible;
    position: relative;
  }

  .room-icon-badge {
    align-items: center;
    aspect-ratio: 1;
    background: var(--bg-container);
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    line-height: 0;
    overflow: visible;
    pointer-events: none;
    position: absolute;
    right: -4%;
    top: -4%;
    z-index: 1;
  }

  .room-icon-badge.globe {
    border-radius: 50%;
    padding: 0;
    width: 62%;
  }

  .room-icon-badge.lock {
    border-radius: var(--radii-300) var(--radii-300) 20% 20%;
    padding: 0;
    width: 64%;
  }

  .room-icon-badge-glyph {
    display: flex;
    flex-shrink: 0;
    height: 100%;
    width: 100%;
  }
</style>
