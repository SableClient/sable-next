<script lang="ts">
  import { untrack } from 'svelte';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { MemberView, PinReadStateView, TimelineItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { useEventItems } from './messages/event-items.svelte.js';
  import { pinErrorMessage } from './timeline/pinned-events.svelte.js';
  import RoomPinItem from './RoomPinItem.svelte';
  import { timelineMediaItems } from '#lib/ui/media/media-items.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';
  import { VirtualWindow } from '#lib/ui/virtual-window.svelte.js';

  const ESTIMATED_ROW = 120;
  const OVERSCAN_ROWS = 4;

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    revision?: string | null;
    open?: boolean;
    onUnread?: (count: number) => void;
    triggerHidden?: boolean;
    onJump: (eventId: string) => void;
  }

  let {
    roomId,
    members,
    canPin,
    revision = null,
    open = $bindable(false),
    onUnread,
    triggerHidden = false,
    onJump,
  }: Props = $props();
  const core = useCoreClient();
  const eventItems = useEventItems();

  let loading = $state(false);
  let pinnedIds = $state.raw<string[]>([]);
  let shownIds = $state.raw<string[]>([]);
  let entries = $state.raw<ReadonlyMap<string, TimelineItemView>>(new Map());
  let pending = $state.raw<ReadonlySet<string>>(new Set());
  let settled = $state.raw<ReadonlySet<string>>(new Set());
  let unreadCount = $state(0);
  let freshIds = $state.raw<ReadonlySet<string>>(new Set());
  let countRun = 0;
  let loadRun = 0;
  let loadedRoom: string | null = null;

  let ordered = $derived([...shownIds].reverse());
  const pinWindow = new VirtualWindow(() => ({
    count: ordered.length,
    key: (index) => ordered[index],
    estimate: ESTIMATED_ROW,
    overscan: OVERSCAN_ROWS,
  }));
  $effect(() => {
    const { first, last } = pinWindow;
    untrack(() => {
      resolveRange(first, last);
    });
  });
  $effect(() => {
    void roomId;
    void revision;
    void refreshCount();
  });

  $effect(() => {
    const target = roomId;
    if (!open || !target) return;

    untrack(() => void load());
  });

  async function refreshCount(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++countRun;
    try {
      const state = await core.rpc.timeline.pinReadState({ room_id: target });
      if (current !== countRun) return;

      adopt(state);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    }
  }

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++loadRun;
    if (target !== loadedRoom) {
      loadedRoom = target;
      shownIds = [];
      entries = new Map();
      pending = new Set();
      settled = new Set();
    }
    loading = true;
    try {
      const ids = await core.rpc.timeline.pinnedEvents({ room_id: target });
      if (current !== loadRun) return;
      pinnedIds = ids;
      shownIds = ids;
      entries = new Map(
        ids.flatMap((id) => {
          const item = entries.get(id) ?? eventItems.peek(target, id);
          return item ? [[id, item] as const] : [];
        })
      );
      pending = new Set();
      settled = new Set(entries.keys());
      await markSeen(target, ids, current);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === loadRun) loading = false;
    }
  }

  async function resolve(target: string, ids: string[], current: number): Promise<void> {
    if (ids.length === 0) return;
    try {
      const items = await core.rpc.timeline.eventItems({ room_id: target, event_ids: ids });
      if (current !== loadRun) return;
      if (items.length > 0) {
        entries = new Map([
          ...entries,
          ...items.flatMap((item) => (item.event_id ? [[item.event_id, item] as const] : [])),
        ]);
        eventItems.put(target, items);
      }
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === loadRun) {
        const done = new Set(ids);
        pending = new Set([...pending].filter((id) => !done.has(id)));
        settled = new Set([...settled, ...ids]);
      }
    }
  }

  function resolveRange(start: number, stop: number): void {
    const missing = ordered
      .slice(Math.max(0, start - OVERSCAN_ROWS), stop + OVERSCAN_ROWS + 1)
      .filter((id) => !settled.has(id) && !pending.has(id));
    if (missing.length === 0) return;
    pending = new Set([...pending, ...missing]);
    void resolve(roomId, missing, loadRun);
  }

  function adopt(state: PinReadStateView): void {
    pinnedIds = state.pinned_ids;
    unreadCount = state.unread;
    onUnread?.(unreadCount);
    freshIds = new Set(state.fresh_ids);
  }

  async function markSeen(target: string, ids: readonly string[], current: number): Promise<void> {
    if (ids.length === 0) return;
    unreadCount = 0;
    onUnread?.(unreadCount);
    try {
      const state = await core.rpc.timeline.markPinsSeen({ room_id: target, pinned_ids: [...ids] });
      if (current !== loadRun) return;
      adopt(state);
    } catch (error) {
      console.debug('[sable room] pin marker not stored', error);
    }
  }

  async function unpin(eventId: string): Promise<void> {
    try {
      pinnedIds = await core.rpc.timeline.setPinned({
        room_id: roomId,
        event_id: eventId,
        pinned: false,
      });
      shownIds = shownIds.filter((id) => id !== eventId);
    } catch (error) {
      console.warn('[sable room] unpin failed', error);
      toasts.error(pinErrorMessage(error));
    }
  }

  function onUnpin(eventId: string): void {
    void unpin(eventId);
  }

  function jump(eventId: string): void {
    open = false;
    onJump(eventId);
  }

  function openMedia(eventId: string): void {
    const items = timelineMediaItems(ordered.flatMap((id) => entries.get(id) ?? []));
    open = false;
    void afterOverlayPops().then(() => mediaViewerState.openPanel(items, eventId, onJump));
  }
</script>

{#snippet pinTrigger({ props }: { props: Record<string, unknown> })}
  <PanelHeaderButton {...props} class="pin-button selection-open" label={i18n.t('room.pinsTitle')}>
    <PushPinIcon weight={open ? 'fill' : 'regular'} />
    {#if pinnedIds.length > 0}
      <span class={['pin-badge', { unread: unreadCount > 0 }]} aria-hidden="true"
        >{pinnedIds.length}</span
      >
    {/if}
  </PanelHeaderButton>
{/snippet}

<ActionMenu
  bind:open
  label={i18n.t('room.pinsTitle')}
  class="pin-menu"
  side="bottom"
  align="center"
  sideOffset={4}
  preventScroll={false}
  trigger={triggerHidden ? undefined : pinTrigger}
  onOpenChange={(next) => {
    if (!next) void refreshCount();
  }}
>
  <IconContext values={{ 'aria-hidden': 'true' }}>
    <header class="pin-header">
      <h2>{i18n.t('room.pinsTitle')}</h2>
      <IconButton
        variant="ghost"
        size="small"
        label={i18n.t('room.pinsClose')}
        onclick={() => {
          open = false;
        }}
      >
        <XIcon />
      </IconButton>
    </header>

    {#if loading && ordered.length === 0}
      <p class="pin-status" role="status"><Spinner small /></p>
    {:else if ordered.length === 0}
      <div class="pin-empty">
        <PushPinIcon />
        <p class="pin-empty-title">{i18n.t('room.pinsEmpty')}</p>
        <p class="pin-empty-hint">{i18n.t('room.pinsEmptyHint')}</p>
      </div>
    {:else}
      <div class="pin-list" {@attach pinWindow.scroller}>
        <div aria-hidden="true" style:height="{pinWindow.spaceBefore}px"></div>
        {#each pinWindow.items as { index, key } (key)}
          {@const eventId = ordered[index]}
          <div class="pin-row" data-index={index} {@attach pinWindow.measure}>
            <RoomPinItem
              {roomId}
              {eventId}
              item={entries.get(eventId) ?? null}
              {members}
              {canPin}
              fresh={freshIds.has(eventId)}
              settled={settled.has(eventId)}
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
</ActionMenu>

<style>
  :global(.menu-surface.pin-menu) {
    --menu-max-height: min(28rem, 70dvh, var(--bits-floating-available-height, 100dvh));

    gap: var(--space-200);
    width: min(28rem, calc(100vw - var(--space-500)));
  }

  :global(.pin-menu > .menu-scroll-content) {
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  :global(.pin-button) {
    position: relative;
  }

  .pin-badge {
    background: var(--surface-container-active);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    inset-inline-start: 0;
    line-height: 1;
    min-width: 1rem;
    padding: var(--space-050) var(--space-100);
    position: absolute;
    text-align: center;
    top: 0;
  }

  .pin-badge.unread {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }

  .pin-header {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
  }

  .pin-header h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

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
