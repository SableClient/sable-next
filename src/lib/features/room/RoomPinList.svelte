<script lang="ts">
  import { untrack } from 'svelte';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { timelineMediaItems } from '#lib/ui/media/media-items.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';
  import { VirtualWindow } from '#lib/ui/virtual-window.svelte.js';

  import { useRoomPins } from './room-pins.svelte.js';
  import { pinErrorMessage } from './timeline/pinned-events.svelte.js';
  import RoomPinItem from './RoomPinItem.svelte';

  const ESTIMATED_ROW = 120;
  const OVERSCAN_ROWS = 4;

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    onJump: (eventId: string) => void;
    onClose?: () => void;
  }

  let { roomId, members, canPin, onJump, onClose }: Props = $props();
  const pins = useRoomPins();

  const pinWindow = new VirtualWindow(() => ({
    count: pins.ordered.length,
    key: (index) => pins.ordered[index],
    estimate: ESTIMATED_ROW,
    overscan: OVERSCAN_ROWS,
  }));
  $effect(() => {
    const { first, last } = pinWindow;
    untrack(() => {
      pins.resolveRange(first - OVERSCAN_ROWS, last + OVERSCAN_ROWS);
    });
  });
  $effect(() => {
    const target = roomId;
    if (!target) return;
    untrack(() => void pins.load(target));
  });

  function onUnpin(eventId: string): void {
    pins.unpin(roomId, eventId).catch((error: unknown) => {
      console.warn('[sable room] unpin failed', error);
      toasts.error(pinErrorMessage(error));
    });
  }

  function jump(eventId: string): void {
    onClose?.();
    onJump(eventId);
  }

  function openMedia(eventId: string): void {
    const items = timelineMediaItems(pins.ordered.flatMap((id) => pins.entries.get(id) ?? []));
    onClose?.();
    void afterOverlayPops().then(() => mediaViewerState.openPanel(items, eventId, onJump));
  }
</script>

<IconContext values={{ 'aria-hidden': 'true' }}>
  {#if pins.loading && pins.ordered.length === 0}
    <p class="pin-status" role="status"><Spinner small /></p>
  {:else if pins.ordered.length === 0}
    <div class="pin-empty">
      <PushPinIcon />
      <p class="pin-empty-title">{i18n.t('room.pinsEmpty')}</p>
      <p class="pin-empty-hint">{i18n.t('room.pinsEmptyHint')}</p>
    </div>
  {:else}
    <div class="pin-list" {@attach pinWindow.scroller}>
      <div aria-hidden="true" style:height="{pinWindow.spaceBefore}px"></div>
      {#each pinWindow.items as { index, key } (key)}
        {@const eventId = pins.ordered[index]}
        <div class="pin-row" data-index={index} {@attach pinWindow.measure}>
          <RoomPinItem
            {roomId}
            {eventId}
            item={pins.entries.get(eventId) ?? null}
            {members}
            {canPin}
            fresh={pins.fresh.has(eventId)}
            settled={pins.settled.has(eventId)}
            onJump={jump}
            {onUnpin}
            onOpenMedia={openMedia}
          />
        </div>
      {/each}
      <div aria-hidden="true" style:height="{pinWindow.spaceAfter}px"></div>
    </div>
  {/if}
</IconContext>

<style>
  .pin-status {
    display: flex;
    justify-content: center;
    margin: 0;
    padding: var(--space-500);
  }

  .pin-empty {
    display: grid;
    gap: var(--space-200);
    justify-items: center;
    padding: var(--space-500) var(--space-400);
    text-align: center;
  }

  .pin-empty :global(svg) {
    color: var(--surface-var-on-container);
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .pin-empty-title {
    font-weight: var(--font-weight-500);
    margin: 0;
  }

  .pin-empty-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .pin-list {
    height: min(24rem, 60dvh);
    max-height: 100%;
    min-height: 0;
    overflow: hidden auto;
    overflow-anchor: none;
  }

  .pin-row {
    box-sizing: border-box;
    padding-bottom: var(--space-200);
  }
</style>
