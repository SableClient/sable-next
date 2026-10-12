<script lang="ts">
  import { untrack } from 'svelte';
  import VirtualList from 'svelte-tiny-virtual-list';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
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
  import MessagePreview from './messages/MessagePreview.svelte';
  import { opensFrom } from './messages/message-preview';
  import { timelineMediaItems } from './media/media-items.js';
  import type { MediaItem } from './media/media-viewer-types.js';

  const ESTIMATED_ROW = 120;
  const ROW_GAP = 8;
  const FALLBACK_LIST_HEIGHT = 384;
  const OVERSCAN_ROWS = 4;

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    revision?: number;
    open?: boolean;
    onUnread?: (count: number) => void;
    triggerHidden?: boolean;
    onJump: (eventId: string) => void;
    onOpenMedia: (items: MediaItem[], eventId: string) => void;
  }

  let {
    roomId,
    members,
    canPin,
    revision = 0,
    open = $bindable(false),
    onUnread,
    triggerHidden = false,
    onJump,
    onOpenMedia,
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
  let run = 0;
  let sizeVersion = $state(0);
  let listHeight = $state(0);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- sizeVersion is the signal
  const heights = new Map<string, number>();

  let ordered = $derived([...shownIds].reverse());
  let rowSize = $derived.by(() => {
    void sizeVersion;
    return (index: number) => heights.get(ordered[index]) ?? ESTIMATED_ROW;
  });
  $effect(() => {
    onUnread?.(unreadCount);
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

    const current = ++run;
    try {
      const state = await core.commands.pinReadState(target);
      if (current !== run) return;

      adopt(state);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    }
  }

  async function load(): Promise<void> {
    const target = roomId;
    if (!target) return;

    const current = ++run;
    loading = true;
    try {
      const ids = await core.commands.pinnedEvents(target);
      if (current !== run) return;
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
      await markSeen(target, ids);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === run) loading = false;
    }
  }

  async function resolve(target: string, ids: string[], current: number): Promise<void> {
    if (ids.length === 0) return;
    try {
      const items = await core.commands.eventItems(target, ids);
      if (current !== run) return;
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
      if (current === run) {
        pending = new Set([...pending].filter((id) => !ids.includes(id)));
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
    void resolve(roomId, missing, run);
  }

  function measure(eventId: string) {
    return (node: HTMLElement) => {
      const observer = new ResizeObserver(() => {
        const height = Math.ceil(node.offsetHeight) + ROW_GAP;
        if (heights.get(eventId) === height) return;
        heights.set(eventId, height);
        sizeVersion += 1;
      });
      observer.observe(node);
      return () => observer.disconnect();
    };
  }

  function adopt(state: PinReadStateView): void {
    pinnedIds = state.pinned_ids;
    unreadCount = state.unread;
    freshIds = new Set(state.fresh_ids);
  }

  async function markSeen(target: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    unreadCount = 0;
    try {
      adopt(await core.commands.markPinsSeen(target, ids));
    } catch (error) {
      console.debug('[sable room] pin marker not stored', error);
    }
  }

  async function unpin(eventId: string): Promise<void> {
    try {
      pinnedIds = await core.commands.setPinned(roomId, eventId, false);
      shownIds = shownIds.filter((id) => id !== eventId);
    } catch (error) {
      console.warn('[sable room] unpin failed', error);
      toasts.error(pinErrorMessage(error));
    }
  }

  function jump(eventId: string): void {
    open = false;
    onJump(eventId);
  }

  function openMedia(eventId: string): void {
    const items = timelineMediaItems(ordered.flatMap((id) => entries.get(id) ?? []));
    open = false;
    void afterOverlayPops().then(() => onOpenMedia(items, eventId));
  }
</script>

{#snippet pinTrigger({ props }: { props: Record<string, unknown> })}
  <PanelHeaderButton {...props} class="pin-button selection-open" label={$i18n.t('room.pinsTitle')}>
    <PushPinIcon weight={open ? 'fill' : 'regular'} />
    {#if pinnedIds.length > 0}
      <span class="pin-badge" class:unread={unreadCount > 0} aria-hidden="true"
        >{pinnedIds.length}</span
      >
    {/if}
  </PanelHeaderButton>
{/snippet}

<ActionMenu
  bind:open
  label={$i18n.t('room.pinsTitle')}
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
      <h2>{$i18n.t('room.pinsTitle')}</h2>
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('room.pinsClose')}
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
        <p class="pin-empty-title">{$i18n.t('room.pinsEmpty')}</p>
        <p class="pin-empty-hint">{$i18n.t('room.pinsEmptyHint')}</p>
      </div>
    {:else}
      <div class="pin-list" bind:clientHeight={listHeight}>
        <VirtualList
          height={listHeight || FALLBACK_LIST_HEIGHT}
          width="100%"
          itemCount={ordered.length}
          itemSize={rowSize}
          estimatedItemSize={ESTIMATED_ROW}
          overscanCount={OVERSCAN_ROWS}
          getKey={(index) => ordered[index]}
          onItemsUpdated={(range) => resolveRange(range.start, range.end)}
        >
          {#snippet item({ index, style })}
            {@const eventId = ordered[index]}
            <div {style} class="pin-row">
              <div class="pin-item" class:fresh={freshIds.has(eventId)} {@attach measure(eventId)}>
                {#if !settled.has(eventId)}
                  <p class="pin-status" role="status"><Spinner small /></p>
                {:else}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <div
                    class="pin-open"
                    onclick={(event) => {
                      if (!opensFrom(event)) return;
                      jump(eventId);
                    }}
                  >
                    <MessagePreview
                      {roomId}
                      {eventId}
                      item={entries.get(eventId) ?? null}
                      {members}
                      loadPreviewProfile
                      timeAction={{
                        label: $i18n.t('common.jumpToMessage'),
                        run: () => jump(eventId),
                      }}
                      onJumpToEvent={jump}
                      onOpenMedia={openMedia}
                    >
                      {#snippet fallback()}
                        <div class="pin-unreadable">
                          <button
                            class="pin-unreadable-open"
                            type="button"
                            aria-label={$i18n.t('common.jumpToMessage')}
                            onclick={() => jump(eventId)}
                          >
                            {$i18n.t('room.pinsUnreadable')}
                          </button>
                          {#if canPin}
                            <IconButton
                              variant="ghost"
                              size="small"
                              label={$i18n.t('timeline.unpinMessage')}
                              onclick={() => void unpin(eventId)}
                            >
                              <PushPinSlashIcon />
                            </IconButton>
                          {/if}
                        </div>
                      {/snippet}
                      {#snippet headerAction()}
                        {#if canPin}
                          <IconButton
                            class="pin-unpin"
                            variant="ghost"
                            size="small"
                            label={$i18n.t('timeline.unpinMessage')}
                            onclick={() => void unpin(eventId)}
                          >
                            <PushPinSlashIcon />
                          </IconButton>
                        {/if}
                      {/snippet}
                    </MessagePreview>
                  </div>
                {/if}
              </div>
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}
  </IconContext>
</ActionMenu>

<style>
  :global(.menu-surface.pin-menu) {
    --menu-max-height: min(28rem, 70dvh);

    gap: var(--space-200);
    width: min(28rem, calc(100vw - var(--space-500)));
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
    left: 0;
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
  }

  .pin-row {
    box-sizing: border-box;
    padding-bottom: var(--space-200);
  }

  .pin-item {
    background: var(--bg-container);
    border-radius: var(--radius-inner);
    color: var(--bg-on-container);
    padding: var(--space-100) var(--space-200) var(--space-100) var(--space-600);
  }

  .pin-item:is(:hover, :focus-within) {
    background: var(--bg-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .pin-item.fresh {
    background: color-mix(in srgb, var(--primary-container) 30%, var(--bg-container));
  }

  .pin-item.fresh:is(:hover, :focus-within) {
    background: color-mix(in srgb, var(--primary-container) 50%, var(--bg-container));
  }

  .pin-open {
    cursor: pointer;
    min-width: 0;
  }

  .pin-item :global(.pin-unpin) {
    flex: none;
    margin-inline-start: var(--space-050);
  }

  .pin-item :global(.message.mention-silent),
  .pin-item :global(.message.mention-loud) {
    margin-inline-start: calc(-1 * (var(--space-400) + var(--border-width) * 4));
    padding-inline-start: var(--space-400);
  }

  .pin-unreadable {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    gap: var(--space-100);
    padding: var(--space-300) 0;
  }

  .pin-unreadable-open {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    flex: 1;
    font: inherit;
    padding: 0;
    text-align: left;
  }

  .pin-unreadable-open:hover {
    text-decoration: underline;
  }
</style>
