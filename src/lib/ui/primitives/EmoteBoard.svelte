<script lang="ts">
  import type { ImagePackView } from '#src/generated/ImagePackView';
  import type { ImageUsageView } from '#src/generated/ImageUsageView';
  import type { PackImageView } from '#src/generated/PackImageView';
  import { useCoreClient } from '#lib/core/context.js';
  import GifGrid from '#lib/features/gif/GifGrid.svelte';
  import type { GifProviderSetting, GifResult, GifsConfig } from '#lib/features/gif/providers.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import type { BoardTab } from '#lib/ui/primitives/emote-board.js';
  import { readBoardSize, trackBoardSize } from '#lib/ui/primitives/board-size.svelte.js';
  import { toInitials } from '#lib/ui/primitives/initials.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import { SvelteSet } from 'svelte/reactivity';

  import { emojiGroups, searchReactionEmoji, shortcodeFor } from '#lib/emoji/emoji.js';
  import { readRecentReactions, rememberReaction } from '#lib/emoji/recents.svelte.js';
  import { readRecent, rememberEmote } from '#lib/emoji/recent-packs.svelte.js';

  interface Props {
    roomId: string;
    tab?: BoardTab;
    query?: string;
    variant?: 'popover' | 'sheet';
    resizable?: boolean;
    /** Reactions can be plain unicode, so the board offers both on one surface. */
    unicode?: boolean;
    /** A reaction key cannot be a sticker. */
    stickers?: boolean;
    gifs?: { config: GifsConfig; providerSetting: GifProviderSetting } | null;
    onPick: (image: PackImageView, usage: ImageUsageView) => void;
    onPickUnicode?: (emoji: string) => void;
    onPickGif?: (gif: GifResult) => void;
  }

  let {
    roomId,
    tab = $bindable<BoardTab>('emoticon'),
    query = $bindable(''),
    variant = 'popover',
    resizable = false,
    unicode = false,
    stickers = true,
    gifs = null,
    onPick,
    onPickUnicode,
    onPickGif,
  }: Props = $props();
  const core = useCoreClient();

  const emojiColumns = 8;

  let packs = $state.raw<ImagePackView[]>([]);
  const loadedPacks = new SvelteSet<string>();
  let loading = $state(true);
  let failed = $state(false);
  let recent = $derived(readRecent());
  let recentReactions = $derived(uniqueReactions());
  let preview = $state.raw<{ image: PackImageView; pack: ImagePackView } | null>(null);
  let activeCell = $state.raw<{ section: string; index: number }>({ section: '', index: 0 });

  $effect(() => {
    let cancelled = false;
    loading = true;
    failed = false;
    void core.commands.imagePacks(roomId).then(
      (loaded) => {
        if (cancelled) return;
        packs = loaded;
        loading = false;
      },
      () => {
        if (cancelled) return;
        failed = true;
        loading = false;
      }
    );
    return () => {
      cancelled = true;
    };
  });

  let gifTab = $derived(tab === 'gif');
  let cellSize = $derived(tab === 'sticker' ? 72 : 32);

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
            key: `${sectionId(section.pack)}-${image.shortcode}`,
            image,
          }))
        )
      : []
  );

  let recentImages = $derived.by(() => {
    if (query.trim() !== '') return [];
    const all = sections.flatMap((section) => section.images);
    return recent
      .map((shortcode) => all.find((image) => image.shortcode === shortcode))
      .filter((image): image is PackImageView => image !== undefined)
      .slice(0, 16);
  });

  let unicodeSections = $derived.by(() => {
    if (!unicode || tab !== 'emoticon') return [];
    const needle = query.trim();
    if (needle !== '') {
      const matches = searchReactionEmoji(needle, 96).map((entry) => entry.emoji);
      return matches.length === 0
        ? []
        : [{ id: 'search', glyph: '🔎', label: $i18n.t('timeline.emojiResults'), emojis: matches }];
    }
    return [
      {
        id: 'recent',
        glyph: '🕘',
        label: $i18n.t('timeline.frequentlyUsed'),
        emojis: recentReactions,
      },
      ...emojiGroups
        .filter((group) => group.emojis.length > 0)
        .map((group) => ({
          id: group.id,
          glyph: group.emojis[0].emoji,
          label: $i18n.t(`emoji.${group.id}`),
          emojis: group.emojis.map((entry) => entry.emoji),
        })),
    ];
  });

  let originLabels: Record<ImagePackView['origin'], string> = $derived({
    account: $i18n.t('composer.packMine'),
    room: $i18n.t('composer.packRoom'),
    global: $i18n.t('composer.packGlobal'),
    space: $i18n.t('composer.packSpace'),
  });

  function packName(pack: ImagePackView): string {
    return pack.name ?? (pack.id || originLabels[pack.origin]);
  }

  function jumpTo(id: string): void {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }

  function sectionId(pack: ImagePackView): string {
    return `pack-${pack.origin}-${pack.room_id ?? 'account'}-${pack.id}`;
  }

  function uniqueReactions(): string[] {
    return [...new Set(readRecentReactions())];
  }

  function emojiRows(emojis: string[]): string[][] {
    const rows: string[][] = [];
    for (let start = 0; start < emojis.length; start += emojiColumns) {
      rows.push(emojis.slice(start, start + emojiColumns));
    }
    return rows;
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
    event.currentTarget.querySelector<HTMLElement>(`[data-cell="${String(index)}"]`)?.focus();
  }

  /** Clicking a cell moves focus too, so the roving tab stop follows it. */
  function trackCell(event: FocusEvent, id: string): void {
    if (!(event.target instanceof HTMLElement)) return;
    const cell = event.target.dataset.cell;
    if (cell !== undefined) activeCell = { section: id, index: Number(cell) };
  }

  /** A reaction key is any string, so an unmatched query is still a valid one. */
  function submitQuery(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !onPickUnicode || gifTab) return;
    const text = query.trim();
    if (text === '') return;
    event.preventDefault();
    const best = unicodeSections.at(0)?.emojis.at(0);
    if (best !== undefined) rememberReaction(best);
    onPickUnicode(best ?? text);
  }

  function attachSize(element: HTMLElement): (() => void) | undefined {
    return resizable ? trackBoardSize(element) : undefined;
  }

  function pick(image: PackImageView): void {
    rememberEmote(image.shortcode);
    onPick(image, tab as ImageUsageView);
  }
</script>

<div
  class={['board', { sheet: variant === 'sheet', resizable }]}
  style={boardStyle}
  {@attach attachSize}
>
  <div class="board-head">
    {#if stickers || gifs}
      <div class="tabs" role="group" aria-label={$i18n.t('composer.emotesAndStickers')}>
        <button
          type="button"
          class="sable-choice"
          aria-pressed={tab === 'emoticon'}
          onclick={() => {
            tab = 'emoticon';
          }}
        >
          {$i18n.t('composer.emoticons')}
        </button>
        {#if stickers}
          <button
            type="button"
            class="sable-choice"
            aria-pressed={tab === 'sticker'}
            onclick={() => {
              tab = 'sticker';
            }}
          >
            {$i18n.t('composer.stickers')}
          </button>
        {/if}
        {#if gifs}
          <button
            type="button"
            class="sable-choice"
            aria-pressed={gifTab}
            onclick={() => {
              tab = 'gif';
            }}
          >
            {$i18n.t('composer.gifs')}
          </button>
        {/if}
      </div>
    {/if}
    <TextInput
      class="board-search"
      type="search"
      bind:value={query}
      placeholder={gifTab ? $i18n.t('composer.searchGifs') : $i18n.t('composer.searchPacks')}
      aria-label={gifTab ? $i18n.t('composer.searchGifs') : $i18n.t('composer.searchPacks')}
      onkeydown={submitQuery}
    />
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
    <div class="board-note"><Spinner /></div>
  {:else if failed}
    <div class="board-note">{$i18n.t('composer.packsFailed')}</div>
  {:else if sections.length === 0 && !unicode}
    <div class="board-note">
      {query.trim() ? $i18n.t('composer.noMatches') : $i18n.t('composer.noPacks')}
    </div>
  {:else}
    <div class="board-body">
      <nav class="rail" class:hidden={searching} aria-label={$i18n.t('composer.packs')}>
        {#each ['account', 'room', 'global', 'space'] as const as origin (origin)}
          {@const group = sections.filter((section) => section.pack.origin === origin)}
          {#if group.length > 0}
            <span class="rail-label">{originLabels[origin]}</span>
            {#each group as section (sectionId(section.pack))}
              <button
                type="button"
                class="rail-pack"
                title={packName(section.pack)}
                aria-label={packName(section.pack)}
                onclick={() => {
                  jumpTo(sectionId(section.pack));
                }}
              >
                {#if section.pack.avatar_url}
                  <Avatar
                    size="small"
                    src={section.pack.avatar_url}
                    initials={toInitials(packName(section.pack), 2)}
                  />
                {:else}
                  <MediaImage
                    class="rail-emote"
                    source={section.images[0].url}
                    alt={packName(section.pack)}
                    width={32}
                    height={32}
                    original
                  />
                {/if}
              </button>
            {/each}
          {/if}
        {/each}
        {#if unicodeSections.length > 0}
          <span class="rail-label">{$i18n.t('emoji.unicode')}</span>
          {#each unicodeSections as section (section.id)}
            <button
              type="button"
              class="rail-pack rail-glyph"
              title={section.label}
              aria-label={section.label}
              onclick={() => {
                jumpTo(`emoji-${section.id}`);
              }}>{section.glyph}</button
            >
          {/each}
        {/if}
      </nav>

      <div class={['grids', { sticker: tab === 'sticker' }]}>
        {#if onPickUnicode && query.trim() !== ''}
          {@const text = query.trim()}
          <button
            type="button"
            class="free-text"
            onclick={() => {
              onPickUnicode(text);
            }}
          >
            {$i18n.t('composer.reactWithText', { text })}
          </button>
        {/if}
        {#if recentImages.length > 0}
          <section>
            <h3>{$i18n.t('composer.recent')}</h3>
            <ul>
              {#each recentImages as image (image.shortcode)}
                <li>
                  <button
                    type="button"
                    title=":{image.shortcode}:"
                    aria-label=":{image.shortcode}:"
                    onclick={() => {
                      pick(image);
                    }}
                  >
                    <MediaImage
                      source={image.url}
                      alt={image.body ?? image.shortcode}
                      width={cellSize}
                      height={cellSize}
                      original
                    />
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#if searching && matchedImages.length > 0}
          <section>
            <h3>{$i18n.t('composer.emoticons')}</h3>
            <ul>
              {#each matchedImages as { key, image } (key)}
                <li>
                  <button
                    type="button"
                    title=":{image.shortcode}:"
                    aria-label=":{image.shortcode}:"
                    onclick={() => {
                      pick(image);
                    }}
                  >
                    <MediaImage
                      source={image.url}
                      alt={image.body ?? image.shortcode}
                      width={cellSize}
                      height={cellSize}
                      original
                    />
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        {#each searching ? [] : sections as section (sectionId(section.pack))}
          {@const id = sectionId(section.pack)}
          <section
            {id}
            class="pack"
            {@attach whenVisible(() => {
              loadedPacks.add(id);
            })}
          >
            <h3>
              {packName(section.pack)}
              <span class="section-origin">{originLabels[section.pack.origin]}</span>
              {#if section.pack.attribution}
                <span class="section-attribution">{section.pack.attribution}</span>
              {/if}
            </h3>
            <ul>
              {#each section.images as image (image.shortcode)}
                <li>
                  <button
                    type="button"
                    title=":{image.shortcode}:"
                    aria-label=":{image.shortcode}:"
                    onclick={() => {
                      pick(image);
                    }}
                    onpointerenter={() => {
                      preview = { image, pack: section.pack };
                    }}
                    onfocus={() => {
                      preview = { image, pack: section.pack };
                    }}
                  >
                    {#if loadedPacks.has(id)}
                      <MediaImage
                        source={image.url}
                        alt={image.body ?? image.shortcode}
                        width={cellSize}
                        height={cellSize}
                        original
                      />
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
        {#each unicodeSections as section (section.id)}
          {@const cursor = activeCell.section === section.id ? activeCell.index : 0}
          <section class="unicode" id={`emoji-${section.id}`}>
            <h3 id={`emoji-head-${section.id}`}>{section.label}</h3>
            <div
              class="grid"
              role="grid"
              tabindex={-1}
              aria-labelledby={`emoji-head-${section.id}`}
              onkeydown={(event) => {
                moveCell(event, section.id, section.emojis.length);
              }}
              onfocusin={(event) => {
                trackCell(event, section.id);
              }}
            >
              {#each emojiRows(section.emojis) as row, rowIndex (rowIndex)}
                <div class="row" role="row">
                  {#each row as emoji, columnIndex (columnIndex)}
                    {@const index = rowIndex * emojiColumns + columnIndex}
                    <button
                      type="button"
                      role="gridcell"
                      data-cell={index}
                      tabindex={index === cursor ? 0 : -1}
                      title={shortcodeFor(emoji) ?? emoji}
                      aria-label={shortcodeFor(emoji) ?? emoji}
                      onclick={() => {
                        rememberReaction(emoji);
                        onPickUnicode?.(emoji);
                      }}>{emoji}</button
                    >
                  {/each}
                </div>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    </div>

    <div class="preview">
      {#if preview}
        <MediaImage
          source={preview.image.url}
          alt=""
          width={28}
          height={28}
          class="preview-image"
          original
        />
        <code>:{preview.image.shortcode}:</code>
        <span class="preview-pack">{packName(preview.pack)}</span>
      {:else}
        <span class="preview-hint">{$i18n.t('composer.previewHint')}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pack {
    contain-intrinsic-size: auto 12rem;
    content-visibility: auto;
  }

  .board {
    display: flex;
    flex-direction: column;
    height: min(22rem, 60dvh);
    width: min(24rem, calc(100vw - 2rem));
  }

  .board.resizable {
    max-height: 85dvh;
    max-width: calc(100vw - 2rem);
    min-height: 14rem;
    min-width: 18rem;
    overflow: hidden;
    resize: both;
  }

  .board.sheet {
    height: min(24rem, 60dvh);
    width: 100%;
  }

  .board-head {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: var(--space-200);
    padding: var(--space-200);
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
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font-size: var(--font-size-small);
    padding: var(--space-150) var(--space-200);
  }

  .board :global(.board-search) {
    font-size: max(var(--font-size-small), var(--font-size-input-min));
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
    border-right: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 3.25rem;
    flex-direction: column;
    gap: var(--space-100);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-200) var(--space-150);
    scrollbar-width: none;
  }

  .rail-label {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    text-transform: lowercase;
    white-space: nowrap;
  }

  .rail-pack {
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    padding: var(--space-050);
  }

  .rail-pack:hover {
    background: var(--sable-surface-container-hover);
  }

  .grids {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-200);
  }

  .grids h3 {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    margin: var(--space-100) 0;
  }

  .section-origin,
  .section-attribution {
    color: var(--sable-surface-var-on-container);
    font-weight: 400;
  }

  .grids ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    list-style: none;
    margin: 0 0 var(--space-300);
    padding: 0;
  }

  .grids.sticker {
    --emote-cell: 5rem;
  }

  .grids li button,
  .grids .unicode button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    height: var(--emote-cell, 2.5rem);
    justify-content: center;
    padding: var(--space-100);
    width: var(--emote-cell, 2.5rem);

    span {
        max-width: 100%;
        max-height: 100%;
      }
  }

  /* Sized to the 32px custom emote beside it, not to the surrounding type. */
  .grids .unicode button {
    font-size: var(--font-size-heading);
    line-height: 1;
    width: 100%;
  }

  .grids li button:hover,
  .grids .unicode button:hover {
    background: var(--sable-surface-container-hover);
  }

  .rail.hidden {
    display: none;
  }

  .free-text {
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    margin-bottom: var(--space-300);
    overflow: hidden;
    padding: var(--space-150) var(--space-200);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  .free-text:hover {
    background: var(--sable-surface-container-hover);
  }

  /* Rows are real elements for the grid pattern, so the wrap is laid out here. */
  .grids .unicode .grid {
    display: grid;
    gap: var(--space-100);
    margin-bottom: var(--space-300);
  }

  /* Column count must match emojiColumns, or the arrow keys walk another grid. */
  .grids .unicode .row {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }

  /* Matches the pack avatars beside it, so the rail reads as one column. */
  .rail-glyph {
    align-items: center;
    font-size: var(--font-size-heading);
    height: var(--avatar-size-small);
    justify-content: center;
    line-height: 1;
    width: var(--avatar-size-small);
  }

  .rail :global(.rail-emote) {
    height: var(--avatar-size-small);
    object-fit: contain;
    width: var(--avatar-size-small);
  }

  .preview {
    align-items: center;
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    min-height: 2.25rem;
    padding: 0 var(--space-200);
  }

  .preview code {
    color: var(--sable-bg-on-container);
  }

  .preview :global(.preview-image) {
    flex: 0 0 1.75rem;
    height: 1.75rem;
    width: 1.75rem;
  }

  .preview :global(.preview-image .media-image-content) {
    object-fit: contain;
  }

  .preview-pack,
  .preview-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .board-note {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 1;
    font-size: var(--font-size-small);
    justify-content: center;
    padding: var(--space-400);
    text-align: center;
  }
</style>
