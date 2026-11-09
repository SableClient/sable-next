<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { innerWidth } from 'svelte/reactivity/window';
  import type {
    EmoteCell as Cell,
    ImagePackView,
    ImageUsageView,
    PackImageView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import GifGrid from '#lib/gif/GifGrid.svelte';
  import type { GifProviderSetting, GifResult, GifsConfig } from '#lib/gif/providers.js';
  import { i18n } from '#lib/i18n.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import { isPackChange, loadPacks } from '#lib/emoji/load-packs.js';
  import { packName } from '#lib/emoji/pack-name.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import VirtualList from 'svelte-tiny-virtual-list';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { emojiGroupIcons, type BoardTab } from '#lib/ui/primitives/emote-board.js';
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import {
    writeBoardSize,
    readBoardSize,
    trackBoardSize,
  } from '#lib/ui/primitives/board-size.svelte.js';
  import { tick, untrack } from 'svelte';

  import { emojiGroups, searchReactionEmoji, shortcodeFor } from '#lib/emoji/emoji.js';
  import { RecentReactions } from '#lib/emoji/recents.svelte.js';
  import { emoteRecents } from '#lib/model/model.js';
  import { readRecentStickers, rememberSticker } from '#lib/emoji/recent-packs.svelte.js';

  interface Props {
    roomId: string;
    tab?: BoardTab;
    query?: string;
    variant?: 'popover' | 'sheet';
    resizable?: boolean;
    /** Reactions can be plain unicode, so the board offers both on one surface. */
    unicode?: boolean;
    unicodeOnly?: boolean;
    /** A reaction key cannot be a sticker. */
    stickers?: boolean;
    reactions?: boolean;
    gifs?: { config: GifsConfig; providerSetting: GifProviderSetting } | null;
    onPick: (image: PackImageView, usage: ImageUsageView, keepOpen: boolean) => void;
    onPickUnicode?: (emoji: string, keepOpen: boolean) => void;
    onPickGif?: (gif: GifResult) => void;
  }

  let {
    roomId,
    tab = $bindable<BoardTab>('emoticon'),
    query = $bindable(''),
    variant = 'popover',
    resizable = false,
    unicode = false,
    unicodeOnly = false,
    stickers = true,
    reactions = false,
    gifs = null,
    onPick,
    onPickUnicode,
    onPickGif,
  }: Props = $props();
  const core = useCoreClient();
  const history = new RecentReactions(core);

  type PickerRow =
    | { id: string; kind: 'lead' }
    | { id: string; kind: 'header'; label: string; pack: ImagePackView | null }
    | {
        id: string;
        kind: 'cells';
        section: string;
        label: string;
        start: number;
        total: number;
        cells: Cell[];
      }
    | { id: string; kind: 'images'; images: PackImageView[]; pack: ImagePackView | null };
  const PACK_HEADER_HEIGHT = 52;
  const GRID_GAP = 4;

  const narrowViewport = new MediaQuery('(width < 24rem)');
  let narrowSheet = $derived(variant === 'sheet' && narrowViewport.current);

  let emojiRowWidth = $state(0);

  let packs = $state.raw<ImagePackView[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let recent = $derived(tab === 'sticker' ? readRecentStickers() : []);
  let preview = $state.raw<{ image: PackImageView; pack: ImagePackView } | null>(null);
  let activeCell = $state.raw<{ section: string; index: number }>({ section: '', index: 0 });
  let gridWidth = $state(0);
  let gridHeight = $state(0);
  let scrollToRow = $state(-1);
  let leadHeight = $state(0);
  let cellRowHeight = $state(48 + GRID_GAP);
  let imageMeasure = $state.raw<{ tab: BoardTab; width: number; gap: number; row: number } | null>(
    null
  );
  let scrollAlign = $state<'start' | 'auto'>('start');
  let mounted = $state.raw({ start: 0, end: 0 });
  let pendingFocus: { section: string; index: number } | null = null;
  let searchFocused = $state(false);
  let chosen = $state.raw<{ key: string; row: number; col: number; source?: string }>({
    key: '',
    row: 0,
    col: 0,
  });

  $effect(() => {
    if (unicodeOnly) {
      loading = false;
      packs = [];
      return;
    }
    let cancelled = false;
    const accountId = core.session?.account_id ?? null;
    loading = true;
    failed = false;
    packs = [];
    const load = (): void => {
      void loadPacks(
        core.rpc,
        roomId,
        (loaded) => {
          if (cancelled) return;
          packs = loaded;
          loading = false;
          failed = false;
        },
        accountId
      ).catch((error: unknown) => {
        console.warn('[sable emotes] the packs could not be loaded', error);
        if (cancelled || packs.length > 0) return;
        failed = true;
        loading = false;
      });
    };
    load();
    const unsubscribe = core.subscribeEvents((event) => {
      if (isPackChange(event)) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  });

  let gifTab = $derived(tab === 'gif');
  let cellSize = $derived(tab === 'sticker' ? 72 : tab === 'emoticon' ? 48 : 32);

  let boardStyle = $derived.by(() => {
    const size = resizable ? readBoardSize() : null;
    return size ? `width: ${String(size.width)}px; height: ${String(size.height)}px;` : undefined;
  });

  let sections = $derived.by(() => {
    if (gifTab) return [];
    const usage = tab as ImageUsageView;
    const needle = query.trim().toLowerCase();
    return packs
      .map((pack) => ({
        pack,
        images: pack.images.filter(
          (image) =>
            image.usage.includes(usage) &&
            (needle === '' || image.shortcode.toLowerCase().includes(needle))
        ),
      }))
      .filter((section) => section.images.length > 0);
  });

  let searching = $derived(query.trim() !== '');
  /** Search is by emote, so matches arrive as one flat list across packs. */
  let matchedImages = $derived(
    searching
      ? sections.flatMap((section) =>
          section.images.map((image) => ({
            image,
            pack: section.pack,
          }))
        )
      : []
  );

  let emojiTab = $derived(unicode && tab === 'emoticon');

  let recents = $derived(
    searching || gifTab
      ? { images: [], cells: [] }
      : emoteRecents({
          recent,
          frequent: history.current,
          images: sections.flatMap((section) => section.images),
          unicode: emojiTab,
          reactions,
        })
  );
  let recentImages = $derived(recents.images);
  let frequentCells = $derived(recents.cells);

  let searchEmojis = $derived(
    emojiTab && searching ? searchReactionEmoji(query.trim(), 96).map((entry) => entry.emoji) : []
  );

  let groupSections = $derived(
    emojiTab && !searching
      ? emojiGroups
          .filter((group) => group.emojis.length > 0)
          .map((group) => ({
            id: group.id,
            icon: emojiGroupIcons[group.id],
            label: i18n.t(`emoji.${group.id}`),
            cells: group.emojis.map((entry): Cell => ({ emoji: entry.emoji })),
          }))
      : []
  );

  let unicodeSections = $derived(
    searchEmojis.length > 0
      ? [
          {
            id: 'search',
            label: i18n.t('timeline.emojiResults'),
            cells: searchEmojis.map((emoji): Cell => ({ emoji })),
          },
        ]
      : groupSections
  );

  let showFreeText = $derived(reactions && onPickUnicode !== undefined && searching);
  let imageCell = $derived(
    imageMeasure?.tab === tab
      ? imageMeasure
      : { width: cellSize, gap: GRID_GAP, row: cellSize + GRID_GAP }
  );
  const emojiColumns = $derived(
    Math.max(
      narrowSheet ? 6 : 7,
      Math.floor((emojiRowWidth + imageCell.gap) / (imageCell.width + imageCell.gap))
    )
  );
  let imageColumns = $derived(
    Math.max(1, Math.floor((gridWidth + imageCell.gap) / (imageCell.width + imageCell.gap)))
  );
  let pickerRows = $derived.by((): PickerRow[] => {
    const rows: PickerRow[] = [];
    if (showFreeText) rows.push({ id: 'lead', kind: 'lead' });
    const addCells = (id: string, label: string, cells: Cell[]): void => {
      if (cells.length === 0) return;
      rows.push({ id: `emoji-${id}`, kind: 'header', label, pack: null });
      for (let start = 0; start < cells.length; start += emojiColumns) {
        rows.push({
          id: `cells-${id}-${String(start)}`,
          kind: 'cells',
          section: id,
          label,
          start,
          total: cells.length,
          cells: cells.slice(start, start + emojiColumns),
        });
      }
    };
    const addImages = (id: string, images: PackImageView[], pack: ImagePackView | null): void => {
      for (let start = 0; start < images.length; start += imageColumns) {
        rows.push({
          id: `${id}-${String(start)}`,
          kind: 'images',
          images: images.slice(start, start + imageColumns),
          pack,
        });
      }
    };

    if (searching) {
      addImages(
        'search',
        matchedImages.map(({ image }) => image),
        null
      );
    } else {
      if (tab === 'sticker') {
        if (recentImages.length > 0) {
          rows.push({
            id: 'emoji-recent',
            kind: 'header',
            label: i18n.t('timeline.frequentlyUsed'),
            pack: null,
          });
          addImages('recent', recentImages, null);
        }
      } else {
        addCells('recent', i18n.t('timeline.frequentlyUsed'), frequentCells);
      }
      for (const section of sections) {
        const id = sectionId(section.pack);
        rows.push({
          id,
          kind: 'header',
          label: packName(section.pack, i18n.t),
          pack: section.pack,
        });
        addImages(id, section.images, section.pack);
      }
    }
    for (const section of unicodeSections) addCells(section.id, section.label, section.cells);
    return rows;
  });
  let rowSize = $derived.by(() => {
    const rows = pickerRows;
    const imageRowHeight = imageCell.row;
    const lead = leadHeight;
    return (index: number): number => {
      const kind = rows[index]?.kind;
      if (kind === 'lead') return lead;
      if (kind === 'cells') return cellRowHeight;
      return kind === 'header' ? PACK_HEADER_HEIGHT : imageRowHeight;
    };
  });
  let rowIndex = $derived(new Map(pickerRows.map((row, index) => [row.id, index])));

  let navRows = $derived(
    pickerRows.filter(
      (row): row is Extract<PickerRow, { kind: 'cells' | 'images' }> =>
        row.kind === 'cells' || row.kind === 'images'
    )
  );
  let navIndex = $derived(new Map(navRows.map((row, index) => [row.id, index])));
  let boardKey = $derived(`${tab}:${query.trim()}`);
  let selection = $derived.by(() => {
    if (chosen.key === boardKey && chosen.source !== undefined) {
      for (const [row, items] of navRows.entries()) {
        const col = rowCells(items).findIndex(
          (cell) => (cell.image?.url ?? cell.emoji) === chosen.source
        );
        if (col >= 0) return { row, col };
      }
    }
    const row = chosen.key === boardKey ? Math.min(chosen.row, navRows.length - 1) : 0;
    const length = navRows[row] ? rowCells(navRows[row]).length : 0;
    return { row, col: chosen.key === boardKey ? Math.min(chosen.col, length - 1) : 0 };
  });

  function rowCells(row: Extract<PickerRow, { kind: 'cells' | 'images' }>): Cell[] {
    return row.kind === 'cells' ? row.cells : row.images.map((image): Cell => ({ image }));
  }

  function selectedCell(): Cell | undefined {
    const row = navRows[selection.row];
    return row ? rowCells(row)[selection.col] : undefined;
  }

  let enterTarget = $derived.by(() => {
    if (!showFreeText || !searchFocused) return '';
    const cell = chosen.key === boardKey ? selectedCell() : undefined;
    return cell ? cellLabel(cell) : i18n.t('composer.reactWithText', { text: query.trim() });
  });

  function isSelected(id: string, column: number): boolean {
    if (showFreeText && chosen.key !== boardKey) return false;
    return searchFocused && selection.row === navIndex.get(id) && selection.col === column;
  }

  function moveSelection(key: string): boolean {
    if (navRows.length === 0) return false;
    let { row, col } = selection;
    const lengthOf = (index: number): number => rowCells(navRows[index]).length;
    if (key === 'ArrowLeft') {
      if (col > 0) col -= 1;
      else if (row > 0) col = lengthOf(--row) - 1;
    } else if (key === 'ArrowRight') {
      if (col < lengthOf(row) - 1) col += 1;
      else if (row < navRows.length - 1) {
        row += 1;
        col = 0;
      }
    } else if (key === 'ArrowUp' && row > 0) {
      row -= 1;
      col = Math.min(col, lengthOf(row) - 1);
    } else if (key === 'ArrowDown' && row < navRows.length - 1) {
      row += 1;
      col = Math.min(col, lengthOf(row) - 1);
    } else if (!key.startsWith('Arrow')) {
      return false;
    }
    chosen = { key: boardKey, row, col };
    const target = rowIndex.get(navRows[row].id);
    if (target !== undefined) requestScroll(target, 'auto');
    return true;
  }

  function pickerRowKey(index: number): string | number {
    return pickerRows[index]?.id ?? index;
  }

  function jumpTo(id: string): void {
    const index = rowIndex.get(id);
    if (index !== undefined) {
      requestScroll(index, 'start');
      return;
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function requestScroll(index: number, align: 'start' | 'auto'): void {
    scrollAlign = align;
    scrollToRow = index;
    void tick().then(() => {
      scrollToRow = -1;
    });
  }

  function sectionId(pack: ImagePackView): string {
    return `pack-${pack.origin}-${pack.room_id ?? 'account'}-${pack.id}`;
  }

  function trackGridSize(element: HTMLElement): () => void {
    const update = (size?: ResizeObserverSize): void => {
      gridHeight = size?.blockSize ?? element.clientHeight;
    };
    update();
    if (typeof ResizeObserver === 'undefined') return () => {};

    const observer = new ResizeObserver(([entry]) => {
      update(entry.contentBoxSize[0]);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }

  function measureImageRow(list: HTMLElement): () => void {
    const measuredTab = tab;
    const update = (size?: ResizeObserverSize): void => {
      const cell = list.firstElementChild;
      if (!(cell instanceof HTMLElement)) return;
      const style = getComputedStyle(list);
      // Measure the row width after space is reserved for the scrollbar.
      const measured = size?.inlineSize ?? Number.parseFloat(style.width);
      // Zoom makes sizes jitter by a fraction of a pixel, and storing that jitter remeasures forever.
      const settled = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
      const lastWidth = untrack(() => gridWidth);
      if (Number.isFinite(measured) && !settled(measured, lastWidth)) gridWidth = measured;
      const bounds = cell.getBoundingClientRect();
      // Match fractional cell sizes to flex wrapping.
      const width = bounds.width;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const row = bounds.height + (Number.parseFloat(style.marginBottom) || 0);
      const last = untrack(() => imageMeasure);
      if (
        last?.tab === measuredTab &&
        settled(last.width, width) &&
        settled(last.gap, gap) &&
        settled(last.row, row)
      )
        return;
      imageMeasure = { tab: measuredTab, width, gap, row };
    };
    update();
    if (typeof ResizeObserver === 'undefined') return () => {};

    const observer = new ResizeObserver(([entry]) => {
      update(entry.contentBoxSize[0]);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }

  function cellLabel(cell: Cell): string {
    return cell.image !== undefined
      ? `:${cell.image.shortcode}:`
      : (shortcodeFor(cell.emoji) ?? cell.emoji);
  }

  function pickCell(cell: Cell, keepOpen: boolean): void {
    if (cell.image !== undefined) {
      pick(cell.image, keepOpen);
      return;
    }
    keepPickFocus(keepOpen, cell.emoji);
    if (!reactions) rememberEmoji(cell.emoji);
    onPickUnicode?.(cell.emoji, keepOpen);
  }

  function keepPickFocus(keepOpen: boolean, source: string): void {
    if (!keepOpen) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    const board = focused.closest('.board');
    const section = focused.closest<HTMLElement>('[data-section]')?.dataset.section;
    void tick().then(() => {
      const target = section
        ? board?.querySelector<HTMLElement>(
            `[data-section="${CSS.escape(section)}"] [data-source="${CSS.escape(source)}"]`
          )
        : focused;
      target?.focus({ preventScroll: true });
    });
  }

  function targetCell(key: string, from: number, last: number): number | null {
    if (key === 'ArrowLeft') return from - 1;
    if (key === 'ArrowRight') return from + 1;
    if (key === 'ArrowUp') return from - emojiColumns;
    if (key === 'ArrowDown') return from + emojiColumns;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return null;
  }

  function moveCell(
    event: KeyboardEvent & { currentTarget: HTMLElement },
    id: string,
    count: number
  ): void {
    const from = activeCell.section === id ? activeCell.index : 0;
    const target = targetCell(event.key, from, count - 1);
    if (target === null) return;

    event.preventDefault();
    const index = Math.min(Math.max(target, 0), count - 1);
    activeCell = { section: id, index };
    const grid = event.currentTarget.closest('.grids');
    const cell = grid?.querySelector<HTMLElement>(
      `[data-section="${id}"] [data-cell="${String(index)}"]`
    );
    if (cell) {
      cell.focus();
      return;
    }
    pendingFocus = { section: id, index };
    const start = Math.floor(index / emojiColumns) * emojiColumns;
    const row = rowIndex.get(`cells-${id}-${String(start)}`);
    if (row !== undefined) requestScroll(row, 'auto');
  }

  function focusWhenPending(section: string, index: number) {
    return (element: HTMLElement): void => {
      if (pendingFocus?.section !== section || pendingFocus.index !== index) return;
      pendingFocus = null;
      element.focus();
    };
  }

  function tabStop(section: string, index: number, column: number): boolean {
    const cursor = activeCell.section === section ? activeCell.index : 0;
    if (index === cursor) return true;
    if (column !== 0) return false;
    const start = Math.floor(cursor / emojiColumns) * emojiColumns;
    const row = rowIndex.get(`cells-${section}-${String(start)}`);
    return row === undefined || row < mounted.start || row > mounted.end;
  }

  /** Clicking a cell moves focus too, so the roving tab stop follows it. */
  function trackCell(event: FocusEvent, id: string): void {
    if (!(event.target instanceof HTMLElement)) return;
    const cell = event.target.dataset.cell;
    if (cell !== undefined) activeCell = { section: id, index: Number(cell) };
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (gifTab) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      if (event.key === 'Enter') submitQuery(event);
      return;
    }
    if (moveSelection(event.key)) {
      event.preventDefault();
      return;
    }
    submitQuery(event);
  }

  /** A reaction key is any string, so an unmatched query is still a valid one. */
  function submitQuery(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    const cell = showFreeText && chosen.key !== boardKey ? undefined : selectedCell();
    if (cell) {
      event.preventDefault();
      if (event.shiftKey) {
        chosen = { key: boardKey, ...selection, source: cell.image?.url ?? cell.emoji };
      }
      pickCell(cell, event.shiftKey);
      return;
    }
    if (!showFreeText) return;
    const text = query.trim();
    if (text === '') return;
    event.preventDefault();
    onPickUnicode?.(text, event.shiftKey);
  }

  function focusSearch(element: HTMLElement): void {
    if (variant !== 'popover' || !window.matchMedia('(any-pointer: fine)').matches) return;
    element.focus({ preventScroll: true });
  }

  function attachSize(element: HTMLElement): (() => void) | undefined {
    return resizable ? trackBoardSize(element) : undefined;
  }

  function showPreview(image: PackImageView, pack: ImagePackView | null): void {
    const owner =
      pack ??
      sections.find((section) => section.images.some((candidate) => candidate.url === image.url))
        ?.pack;
    if (owner) preview = { image, pack: owner };
  }

  function pick(image: PackImageView, keepOpen: boolean): void {
    keepPickFocus(keepOpen, image.url);
    if (!reactions) {
      if (tab === 'sticker') rememberSticker(image.url);
      else rememberEmoji(image.url);
    }
    onPick(image, tab as ImageUsageView, keepOpen);
  }

  function rememberEmoji(key: string): void {
    core.rpc.messages.rememberEmoji({ key }).catch((error: unknown) => {
      console.warn('[sable emotes] the pick could not be remembered', error);
    });
  }

  const MIN_BOARD_WIDTH = 250;
  let maxBoardWidth = $derived(Math.max(MIN_BOARD_WIDTH, (innerWidth.current ?? 0) - 32));

  function resizeBoard(width: number): void {
    writeBoardSize({
      width: Math.max(MIN_BOARD_WIDTH, Math.min(maxBoardWidth, width)),
      height: readBoardSize()?.height ?? 457,
    });
  }
</script>

<div
  class={['board', { sheet: variant === 'sheet', resizable }]}
  style={boardStyle}
  {@attach attachSize}
>
  {#if resizable}
    <ResizeHandle
      value={readBoardSize()?.width ?? 550}
      min={MIN_BOARD_WIDTH}
      max={maxBoardWidth}
      label={i18n.t('composer.resizeBoard')}
      grow="left"
      step={16}
      shiftStep={64}
      onResize={resizeBoard}
    />
  {/if}
  <div class="board-head">
    {#if stickers || gifs}
      <div class="tabs" role="group" aria-label={i18n.t('composer.emotesAndStickers')}>
        <button
          type="button"
          class="choice"
          aria-pressed={tab === 'emoticon'}
          onclick={() => {
            tab = 'emoticon';
          }}
        >
          {i18n.t('composer.emoticons')}
        </button>
        {#if stickers}
          <button
            type="button"
            class="choice"
            aria-pressed={tab === 'sticker'}
            onclick={() => {
              tab = 'sticker';
            }}
          >
            {i18n.t('composer.stickers')}
          </button>
        {/if}
        {#if gifs}
          <button
            type="button"
            class="choice"
            aria-pressed={gifTab}
            onclick={() => {
              tab = 'gif';
            }}
          >
            {i18n.t('composer.gifs')}
          </button>
        {/if}
      </div>
    {/if}
    <TextInput
      class="board-search"
      type="search"
      bind:value={query}
      placeholder={gifTab ? i18n.t('composer.searchGifs') : i18n.t('composer.searchPacks')}
      aria-label={gifTab ? i18n.t('composer.searchGifs') : i18n.t('composer.searchPacks')}
      onkeydown={searchKeydown}
      onfocus={() => {
        searchFocused = true;
      }}
      onblur={() => {
        searchFocused = false;
      }}
      {@attach focusSearch}
    />
    <span class="sr-only" role="status">{enterTarget}</span>
    {#if !gifTab && sections.length > 0}
      <p class="pack-visibility">{i18n.t('composer.packMediaVisibility')}</p>
    {/if}
  </div>

  {#if gifs && gifTab}
    <GifGrid
      config={gifs.config}
      providerSetting={gifs.providerSetting}
      {query}
      onPick={(gif: GifResult) => {
        onPickGif?.(gif);
      }}
    />
  {:else if loading}
    <div class="board-note"><Spinner label={i18n.t('a11y.loading')} /></div>
  {:else if failed}
    <div class="board-note">{i18n.t('composer.packsFailed')}</div>
  {:else if sections.length === 0 && !unicode}
    <div class="board-note">
      {query.trim() ? i18n.t('composer.noMatches') : i18n.t('composer.noPacks')}
    </div>
  {:else}
    <div class="board-body">
      <div
        class={['grids', { sticker: tab === 'sticker', emoji: tab === 'emoticon' }]}
        {@attach trackGridSize}
      >
        {#key `${tab}:${query.trim()}`}
          <VirtualList
            height={gridHeight}
            width="100%"
            itemCount={pickerRows.length}
            itemSize={rowSize}
            estimatedItemSize={cellSize + GRID_GAP}
            overscanCount={2}
            getKey={pickerRowKey}
            scrollToIndex={scrollToRow === -1 ? undefined : scrollToRow}
            scrollToAlignment={scrollAlign}
            onItemsUpdated={(range) => {
              mounted = range;
            }}
            scrollToBehaviour={scrollAlign === 'start' || shouldReduceMotion()
              ? 'instant'
              : 'smooth'}
          >
            {#snippet item({ index, style })}
              {@const row = pickerRows[index]}
              <div {style} class="virtual-row">
                {#if row.kind === 'lead'}
                  <div bind:clientHeight={leadHeight}>
                    {#if showFreeText}
                      {@const text = query.trim()}
                      <button
                        type="button"
                        class="free-text"
                        onclick={(event) => {
                          onPickUnicode?.(text, event.shiftKey);
                        }}
                      >
                        {i18n.t('composer.reactWithText', { text })}
                      </button>
                    {/if}
                  </div>
                {:else if row.kind === 'header'}
                  <h3>{row.label}</h3>
                {:else if row.kind === 'cells'}
                  <div
                    class="unicode"
                    role="grid"
                    tabindex={-1}
                    aria-label={row.label}
                    data-section={row.section}
                    onkeydown={(event) => {
                      moveCell(event, row.section, row.total);
                    }}
                    onfocusin={(event) => {
                      trackCell(event, row.section);
                    }}
                  >
                    <div
                      class="row"
                      role="row"
                      bind:clientHeight={cellRowHeight}
                      bind:clientWidth={emojiRowWidth}
                      style={`grid-template-columns: repeat(${String(emojiColumns)}, minmax(0, var(--emote-cell)))`}
                    >
                      {#each row.cells as cell, column (column)}
                        {@const index = row.start + column}
                        {@const source = cell.image !== undefined ? cell.image.url : cell.emoji}
                        {@const label = cellLabel(cell)}
                        <Tooltip {label}>
                          {#snippet trigger({ props })}
                            <button
                              {...props}
                              type="button"
                              role="gridcell"
                              data-cell={index}
                              data-source={source}
                              data-selected={isSelected(row.id, column) || undefined}
                              tabindex={tabStop(row.section, index, column) ? 0 : -1}
                              aria-label={label}
                              onclick={(event) => {
                                pickCell(cell, event.shiftKey);
                              }}
                              onpointerenter={() => {
                                if (cell.image !== undefined) showPreview(cell.image, null);
                              }}
                              onfocus={() => {
                                if (cell.image !== undefined) showPreview(cell.image, null);
                              }}
                              {@attach focusWhenPending(row.section, index)}
                            >
                              {#if source.startsWith('mxc://')}
                                <MediaImage
                                  class="unicode-image"
                                  {source}
                                  alt=""
                                  width={64}
                                  height={64}
                                  original
                                  emoticon
                                />
                              {:else}
                                <span class="unicode-text">{source}</span>
                              {/if}
                            </button>
                          {/snippet}
                        </Tooltip>
                      {/each}
                    </div>
                  </div>
                {:else}
                  <ul
                    style={`grid-template-columns: repeat(${String(imageColumns)}, var(--emote-cell))`}
                    {@attach measureImageRow}
                  >
                    {#each row.images as image, column (column)}
                      {@const imageLabel = `:${image.shortcode}:`}
                      <li>
                        <Tooltip label={imageLabel}>
                          {#snippet trigger({ props })}
                            <button
                              {...props}
                              type="button"
                              aria-label={imageLabel}
                              data-selected={isSelected(row.id, column) || undefined}
                              onclick={(event) => {
                                pick(image, event.shiftKey);
                              }}
                              onpointerenter={() => {
                                showPreview(image, row.pack);
                              }}
                              onfocus={() => {
                                showPreview(image, row.pack);
                              }}
                            >
                              <MediaImage
                                source={image.url}
                                alt={image.body ?? image.shortcode}
                                width={cellSize}
                                height={cellSize}
                                original
                                emoticon
                              />
                            </button>
                          {/snippet}
                        </Tooltip>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/snippet}
          </VirtualList>
        {/key}
      </div>

      <nav class={['rail', { hidden: searching }]} aria-label={i18n.t('composer.packs')}>
        {#if frequentCells.length > 0}
          {@const frequentLabel = i18n.t('timeline.frequentlyUsed')}
          <Tooltip label={frequentLabel}>
            {#snippet trigger({ props })}
              <button
                {...props}
                type="button"
                class="rail-pack rail-glyph"
                aria-label={frequentLabel}
                onclick={() => {
                  jumpTo('emoji-recent');
                }}
              >
                <ClockCounterClockwiseIcon />
              </button>
            {/snippet}
          </Tooltip>
        {/if}
        {#each ['account', 'global', 'room', 'space'] as const as origin (origin)}
          {@const group = sections.filter((section) => section.pack.origin === origin)}
          {#if group.length > 0}
            <hr class="rail-divider" />
            {#each group as section (sectionId(section.pack))}
              {@const packLabel = packName(section.pack, i18n.t)}
              <Tooltip label={packLabel}>
                {#snippet trigger({ props })}
                  <button
                    {...props}
                    type="button"
                    class="rail-pack"
                    aria-label={packLabel}
                    onclick={() => {
                      jumpTo(sectionId(section.pack));
                    }}
                  >
                    <MediaImage
                      class="rail-emote"
                      source={section.pack.avatar_url ?? section.images[0].url}
                      alt={packLabel}
                      width={24}
                      height={24}
                      original
                    />
                  </button>
                {/snippet}
              </Tooltip>
            {/each}
          {/if}
        {/each}
        {#if groupSections.length > 0}
          <hr class="rail-divider" />
          {#each groupSections as section (section.id)}
            <Tooltip label={section.label}>
              {#snippet trigger({ props })}
                <button
                  {...props}
                  type="button"
                  class="rail-pack rail-glyph"
                  aria-label={section.label}
                  onclick={() => {
                    jumpTo(`emoji-${section.id}`);
                  }}
                >
                  <section.icon />
                </button>
              {/snippet}
            </Tooltip>
          {/each}
        {/if}
      </nav>
    </div>

    <div class="preview">
      {#if preview}
        <MediaImage
          source={preview.image.url}
          alt=""
          width={32}
          height={32}
          class="preview-image"
          original
        />
        <code>:{preview.image.shortcode}:</code>
        <span class="preview-pack">{packName(preview.pack, i18n.t)}</span>
      {:else}
        <span class="preview-hint">{i18n.t('composer.previewHint')}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .board {
    display: flex;
    flex-direction: column;
    height: min(28rem, 60dvh);
    width: min(27rem, calc(100vw - 2rem));
  }

  .board.sheet {
    height: min(36rem, calc(100dvh - var(--keyboard-overlap) - 7rem));
    width: 100%;
  }

  @media (any-hover: none) {
    .board.sheet .preview:has(.preview-hint) {
      display: none;
    }
  }

  .board-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-300) var(--space-300) 0;
  }

  .pack-visibility {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .tabs {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-050);
  }

  .tabs button {
    background: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    font-size: var(--font-size-small);
    padding: var(--space-150) var(--space-200);
  }

  .board :global(.board-search) {
    font-size: max(var(--font-size-label), var(--font-size-input-min));
    min-width: 0;
  }

  .board-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* Fixed, or a long pack name widens the rail and squeezes the grid. */
  .rail {
    align-items: center;
    border-left: var(--border-width) solid var(--surface-container-line);
    display: flex;
    flex: 0 0 3.25rem;
    flex-direction: column;
    gap: var(--space-200);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }

  .rail-divider {
    border: 0;
    border-top: var(--border-width) solid var(--surface-container-line);
    flex: 0 0 auto;
    margin: var(--space-100) 0;
    width: var(--size-x100);
  }

  .board :global(.media-image.pixelated .media-image-content) {
    image-rendering: auto;
  }

  .rail-pack {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--avatar-size-small);
    justify-content: center;
    padding: 0;
    width: var(--avatar-size-small);
  }

  .rail-pack:hover {
    background: var(--surface-container-hover);
  }

  .grids {
    --emote-cell: 3rem;

    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .grids :global(.virtual-list-wrapper) {
    scrollbar-gutter: stable;
  }

  .virtual-row {
    overflow: hidden;
  }

  .grids h3 {
    align-items: baseline;
    background: var(--surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    justify-content: center;
    margin: 0 auto var(--space-200);
    padding: var(--space-100) var(--space-200);
    position: sticky;
    text-transform: uppercase;
    top: 0;
    width: max-content;
    z-index: 1;
  }

  .grids ul {
    display: grid;
    justify-content: center;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .grids.sticker {
    --emote-cell: 7rem;
  }

  .board.sheet .grids.sticker {
    --emote-cell: 5rem;
  }

  .grids.emoji {
    --emote-cell: 3rem;
  }

  .grids li button,
  .grids .unicode button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    height: var(--emote-cell);
    justify-content: center;
    padding: var(--space-200);
    width: var(--emote-cell);
  }

  .grids li button :global(.media-image) {
    height: 100%;
    width: 100%;
  }

  .grids li button :global(.media-image-content) {
    object-fit: contain;
  }

  /* The 8-column rows own their width, so a wider emote cell must not stretch them. */
  .grids .unicode {
    --emote-cell: 3rem;
  }

  .grids .unicode button {
    font-size: calc(var(--emote-cell) * 0.667);
    line-height: 1;
    padding-inline: 0;
    width: 100%;
  }

  .grids .unicode button :global(.unicode-image) {
    height: 100%;
    max-width: 100%;
    object-fit: contain;
    width: calc(var(--emote-cell) * 0.667 * var(--media-ratio));
  }

  .unicode-text {
    line-height: normal;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grids li button:hover,
  .grids .unicode button:hover,
  .grids li button[data-selected],
  .grids .unicode button[data-selected] {
    background: var(--surface-container-hover);
  }

  .rail.hidden {
    display: none;
  }

  .sr-only {
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .free-text {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    margin: var(--space-200);
    overflow: hidden;
    padding: var(--space-150) var(--space-200);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 98%;
  }

  .free-text:hover {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  /* Rows are real elements for the grid pattern, so the wrap is laid out here. */
  .grids .unicode .row {
    display: grid;
    justify-content: center;
    padding-bottom: var(--space-100);
  }

  .rail-glyph {
    font-size: var(--icon-size-small);
  }

  .rail :global(.rail-emote) {
    height: var(--avatar-size-300);
    width: var(--avatar-size-300);
  }

  .rail :global(.rail-emote .media-image-content) {
    object-fit: contain;
  }

  .preview {
    align-items: center;
    background: var(--surface-var-container);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    margin: 0 var(--space-300) var(--space-300);
    min-height: 2.5rem;
    padding: var(--space-200);
  }

  .preview code {
    color: inherit;
    font-size: var(--font-size-subheading);
    min-width: 0;
  }

  .preview :global(.preview-image) {
    flex: 0 0 2rem;
    height: 2rem;
    width: 2rem;
  }

  .preview :global(.preview-image .media-image-content) {
    object-fit: contain;
  }

  .preview code,
  .preview-pack,
  .preview-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .board-note {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex: 1;
    font-size: var(--font-size-small);
    justify-content: center;
    padding: var(--space-400);
    text-align: center;
  }

  .board :global(.resize-handle) {
    border-radius: 10px;
  }
</style>
