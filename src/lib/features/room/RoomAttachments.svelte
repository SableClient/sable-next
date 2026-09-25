<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import type {
    MemberView,
    RoomAttachmentContentView,
    RoomAttachmentKind,
    RoomAttachmentView,
  } from '#src/generated/protocol';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import FileAudioIcon from 'phosphor-svelte/lib/FileAudioIcon';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import FileImageIcon from 'phosphor-svelte/lib/FileImageIcon';
  import FilePdfIcon from 'phosphor-svelte/lib/FilePdfIcon';
  import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
  import FileVideoIcon from 'phosphor-svelte/lib/FileVideoIcon';
  import FileZipIcon from 'phosphor-svelte/lib/FileZipIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
  import ChatCenteredTextIcon from 'phosphor-svelte/lib/ChatCenteredTextIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import { groupByMonth } from './attachment-groups';
  import { parseMatrixLink, type MatrixLink } from './matrix-link';
  import type { MediaItem } from './MediaViewer.svelte';
  import { galleryItemId } from './media-items.js';
  import { memberName } from './members';
  import { formatDate } from './timeline-format';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onOpenMedia: (items: MediaItem[], eventId: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onClose: () => void;
  }

  let {
    roomId,
    members,
    modal = false,
    onJump,
    onOpenMedia,
    onMatrixLink,
    onClose,
  }: Props = $props();

  const PAGE = 30;
  const EMPTY_PAGES_BEFORE_PAUSE = 5;
  const LINKS_PER_ROW = 3;
  const PREFETCH_BAND = '0px 0px 240px 0px';
  const GRID_COLUMNS = 3;
  const STILL_MIMES = new Set(['image/gif', 'image/webp', 'image/apng', 'image/avif']);
  const tabs: readonly { id: RoomAttachmentKind; label: string; empty: string }[] = [
    { id: 'media', label: 'timeline.attachmentsMedia', empty: 'timeline.attachmentsMediaEmpty' },
    { id: 'file', label: 'timeline.attachmentsFiles', empty: 'timeline.attachmentsFilesEmpty' },
    { id: 'link', label: 'timeline.attachmentsLinks', empty: 'timeline.attachmentsLinksEmpty' },
  ];

  const core = useCoreClient();
  let kind = $state<RoomAttachmentKind>('media');
  let items = $state.raw<RoomAttachmentView[]>([]);
  let offset = $state(0);
  let exhausted = $state(false);
  let loading = $state(true);
  let failed = $state(false);
  let paused = $state(false);
  let activeTile = $state<string | null>(null);
  let generation = 0;

  let emptyLabel = $derived(tabs.find((tab) => tab.id === kind)?.empty ?? '');
  let groups = $derived(groupByMonth(items));
  let viewerItems = $derived(items.flatMap((item) => mediaItem(item)));
  let focusableTile = $derived(
    activeTile !== null && items.some((item) => attachmentKey(item) === activeTile)
      ? activeTile
      : items[0]
        ? attachmentKey(items[0])
        : null
  );
  let showEmpty = $derived(items.length === 0 && !loading && !failed && exhausted);

  async function load(): Promise<void> {
    const run = ++generation;
    const target = roomId;
    const wanted = kind;
    let from = offset;
    loading = true;
    failed = false;
    paused = false;
    try {
      for (let hop = 0; ; hop += 1) {
        const page = await core.commands.roomAttachments(target, wanted, PAGE, from);
        if (run !== generation) return;
        const fresh = from === 0 ? page.items : unseen(page.items);
        items = from === 0 ? fresh : [...items, ...fresh];
        from += PAGE;
        offset = from;
        exhausted = page.exhausted;
        if (fresh.length > 0 || page.exhausted) break;
        if (hop + 1 >= EMPTY_PAGES_BEFORE_PAUSE) {
          paused = true;
          break;
        }
      }
    } catch (error) {
      console.debug('[sable room] attachments unavailable', error);
      if (run === generation) failed = true;
    } finally {
      if (run === generation) loading = false;
    }
  }

  function unseen(page: readonly RoomAttachmentView[]): RoomAttachmentView[] {
    const loaded = new Set(items.map(attachmentKey));
    return page.filter((item) => !loaded.has(attachmentKey(item)));
  }

  function attachmentKey(item: RoomAttachmentView): string {
    return item.gallery_index === null
      ? item.event_id
      : galleryItemId(item.event_id, item.gallery_index);
  }

  function loadMore(): void {
    if (loading || exhausted || failed || paused) return;
    void load();
  }

  $effect(() => {
    void roomId;
    void kind;
    untrack(() => {
      items = [];
      offset = 0;
      exhausted = false;
      void load();
    });
  });

  function nearEnd(node: HTMLElement): () => void {
    if (typeof IntersectionObserver === 'undefined') return () => {};
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: node.closest('.attachments-body'), rootMargin: PREFETCH_BAND }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }

  function selectTab(next: RoomAttachmentKind, focus: boolean): void {
    kind = next;
    if (focus) document.getElementById(`attachments-tab-${next}`)?.focus();
  }

  function tabKeydown(event: KeyboardEvent): void {
    const index = tabs.findIndex((tab) => tab.id === kind);
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + last) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) selectTab(tab.id, true);
  }

  function senderOf(item: RoomAttachmentView): string {
    return memberName(members, item.sender);
  }

  function mediaItem(item: RoomAttachmentView): MediaItem[] {
    const content = item.content;
    const shared = {
      eventId: attachmentKey(item),
      sender: senderOf(item),
      caption: null,
      html: null,
    };
    switch (content.kind) {
      case 'image':
        return [
          {
            ...shared,
            kind: 'image',
            filename: content.filename,
            source: content.source,
            mime: content.mime,
            width: content.width,
            height: content.height,
            size: null,
            blurhash: content.blurhash,
            thumbnail: content.thumbnail,
            spoiler: content.spoiler,
          },
        ];
      case 'video':
        return [
          {
            ...shared,
            kind: 'video',
            filename: content.filename,
            source: content.source,
            mime: content.mime,
            width: content.width,
            height: content.height,
            blurhash: content.blurhash,
            thumbnail: content.thumbnail,
            spoiler: content.spoiler,
          },
        ];
      case 'file':
        if (content.mime?.startsWith('audio/')) {
          return [
            {
              ...shared,
              kind: 'audio',
              filename: content.filename,
              source: content.source,
              mime: content.mime,
              duration_ms: null,
              waveform: null,
              voice: false,
            },
          ];
        }
        return [
          {
            ...shared,
            kind: 'file',
            filename: content.filename,
            source: content.source,
            mime: content.mime,
            size: content.size,
          },
        ];
      case 'link':
        return [];
    }
  }

  function open(item: RoomAttachmentView): void {
    onOpenMedia(viewerItems, attachmentKey(item));
  }

  function afterClosing(action: () => void): void {
    if (!modal) {
      action();
      return;
    }
    onClose();
    void afterOverlayPops().then(action);
  }

  function jump(eventId: string): void {
    afterClosing(() => {
      onJump(eventId);
    });
  }

  function followLink(event: MouseEvent, url: string): void {
    const link = parseMatrixLink(url);
    const anchor = event.currentTarget;
    if (!link || !onMatrixLink || !(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    afterClosing(() => {
      onMatrixLink(link, anchor);
    });
  }

  function tileKeydown(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? GRID_COLUMNS
            : event.key === 'ArrowUp'
              ? -GRID_COLUMNS
              : null;
    const current = event.currentTarget;
    if (step === null || !(current instanceof HTMLElement)) return;
    const tiles = Array.from(
      current.closest('.attachments-body')?.querySelectorAll<HTMLElement>('.media-tile') ?? []
    );
    const next = tiles[tiles.indexOf(current) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function itemLabel(item: RoomAttachmentView, name: string): string {
    return $i18n.t('timeline.attachmentsOpenItem', {
      name,
      sender: senderOf(item),
      date: formatDate(item.timestamp),
    });
  }

  function mediaName(content: RoomAttachmentContentView): string {
    if (content.kind === 'link') return '';
    if ((content.kind === 'image' || content.kind === 'video') && content.spoiler !== null) {
      return content.spoiler
        ? $i18n.t('timeline.attachmentsSpoilerReason', { reason: content.spoiler })
        : $i18n.t('timeline.attachmentsSpoiler');
    }
    if (content.kind === 'video') {
      return $i18n.t('timeline.attachmentsVideoNamed', { name: content.filename });
    }
    return content.filename;
  }

  function fileIcon(mime: string | null): Component {
    const type = mime ?? '';
    if (type.startsWith('audio/')) return FileAudioIcon;
    if (type.startsWith('video/')) return FileVideoIcon;
    if (type.startsWith('image/')) return FileImageIcon;
    if (type === 'application/pdf') return FilePdfIcon;
    if (type.startsWith('text/')) return FileTextIcon;
    if (/zip|x-7z|x-rar|x-tar|gzip|x-bzip/.test(type)) return FileZipIcon;
    return FileIcon;
  }

  function splitUrl(url: string): { host: string; rest: string } {
    try {
      const parsed = new URL(url);
      const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return { host: parsed.host, rest: rest === '/' ? '' : rest };
    } catch {
      return { host: url, rest: '' };
    }
  }
</script>

{#snippet skeleton()}
  {#if kind === 'media'}
    <div class="media-grid skeleton-grid" aria-hidden="true">
      {#each { length: 9 }, index (index)}
        <Skeleton class="media-skeleton" />
      {/each}
    </div>
  {:else}
    <div class="row-skeletons" aria-hidden="true">
      {#each { length: 5 }, index (index)}
        <div class="row-skeleton">
          <Skeleton class="row-skeleton-icon" />
          <span class="row-skeleton-lines">
            <Skeleton class="row-skeleton-line" />
            <Skeleton class="row-skeleton-line short" />
          </span>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet mediaTile(item: RoomAttachmentView)}
  {@const content = item.content}
  {#if content.kind === 'image' || content.kind === 'video'}
    {@const hidden = content.spoiler !== null}
    {@const preview = content.kind === 'image' ? content.source : content.thumbnail}
    <button
      type="button"
      class="media-tile"
      aria-label={itemLabel(item, mediaName(content))}
      tabindex={focusableTile === attachmentKey(item) ? 0 : -1}
      onfocus={() => {
        activeTile = attachmentKey(item);
      }}
      onkeydown={tileKeydown}
      onclick={() => {
        open(item);
      }}
    >
      {#if hidden}
        <span class="tile-placeholder">
          <EyeSlashIcon aria-hidden="true" />
          <span class="tile-placeholder-label">{mediaName(content)}</span>
        </span>
      {:else if preview === null}
        <span class="tile-placeholder">
          <FileVideoIcon aria-hidden="true" />
          <span class="tile-placeholder-label">{$i18n.t('timeline.attachmentsVideo')}</span>
        </span>
      {:else}
        <MediaImage
          class="tile-image privacy-media"
          style="aspect-ratio: 1 / 1"
          source={preview}
          thumbnail={content.kind === 'image' ? content.thumbnail : null}
          alt=""
          width={160}
          height={160}
          intrinsicWidth={content.width}
          intrinsicHeight={content.height}
          mime={content.kind === 'image' && !STILL_MIMES.has(content.mime ?? '')
            ? content.mime
            : null}
          blurhash={content.blurhash}
          autoplay
        />
      {/if}
      {#if content.kind === 'video' && !hidden && preview !== null}
        <span class="tile-badge" aria-hidden="true"><PlayIcon weight="fill" /></span>
      {/if}
      <span class="tile-meta" aria-hidden="true"
        >{senderOf(item)} · {formatDate(item.timestamp)}</span
      >
    </button>
  {/if}
{/snippet}

{#snippet row(item: RoomAttachmentView)}
  {@const content = item.content}
  {#if content.kind === 'file'}
    {@const Icon = fileIcon(content.mime)}
    <button
      type="button"
      class="attachment-row"
      aria-label={itemLabel(item, content.filename)}
      onclick={() => {
        open(item);
      }}
    >
      <Icon class="attachment-icon" aria-hidden="true" />
      <span class="attachment-text">
        <span class="attachment-name">{content.filename}</span>
        <span class="attachment-meta">
          {#if content.size !== null}
            <span>{formatByteSize(content.size)}</span>
          {/if}
          <span class="attachment-sender">{senderOf(item)}</span>
          <span>{formatDate(item.timestamp)}</span>
        </span>
      </span>
    </button>
  {:else if content.kind === 'link'}
    <div class="attachment-row link-row">
      <span class="link-text">
        {#each content.urls.slice(0, LINKS_PER_ROW) as url (url)}
          {@const parts = splitUrl(url)}
          <a
            class="link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            onclick={(event) => {
              followLink(event, url);
            }}
          >
            <span class="link-host">{parts.host}</span>
            {#if parts.rest}
              <span class="link-rest">{parts.rest}</span>
            {/if}
          </a>
        {/each}
        {#if content.urls.length > LINKS_PER_ROW}
          <span class="link-more">
            {$i18n.t('timeline.attachmentsMoreLinks', {
              count: content.urls.length - LINKS_PER_ROW,
            })}
          </span>
        {/if}
        <span class="attachment-meta">
          <span class="attachment-sender">{senderOf(item)}</span>
          <span>{formatDate(item.timestamp)}</span>
        </span>
      </span>
      <IconButton
        class="link-jump"
        variant="ghost"
        size="small"
        label={`${$i18n.t('timeline.attachmentsJump')}: ${senderOf(item)}, ${formatDate(item.timestamp)}`}
        onclick={() => {
          jump(item.event_id);
        }}
      >
        <ChatCenteredTextIcon />
      </IconButton>
    </div>
  {/if}
{/snippet}

{#snippet body()}
  <aside class={['attachments', { modal }]} aria-label={$i18n.t('timeline.attachmentsTitle')}>
    <PanelHeader class="attachments-header" title={$i18n.t('timeline.attachmentsTitle')}>
      {#snippet prefix()}
        <ImagesIcon aria-hidden="true" />
      {/snippet}
      {#snippet suffix()}
        <PanelHeaderButton label={$i18n.t('timeline.attachmentsClose')} onclick={onClose}>
          <XIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>

    <div class="tabs" role="tablist" aria-label={$i18n.t('timeline.attachmentsTitle')}>
      {#each tabs as tab (tab.id)}
        <Button
          size="small"
          variant="ghost"
          class="attachments-tab choice"
          role="tab"
          id={`attachments-tab-${tab.id}`}
          aria-controls="attachments-panel"
          aria-selected={kind === tab.id}
          tabindex={kind === tab.id ? 0 : -1}
          onkeydown={tabKeydown}
          onclick={() => {
            selectTab(tab.id, false);
          }}
        >
          {$i18n.t(tab.label)}
        </Button>
      {/each}
    </div>
    {#if !showEmpty}
      <p class="attachments-scope">{$i18n.t('timeline.attachmentsIndexed')}</p>
    {/if}
    <p class="screen-reader-only" aria-live="polite">
      {items.length > 0 ? $i18n.t('timeline.attachmentsLoaded', { count: items.length }) : ''}
    </p>

    <div
      class="attachments-body"
      role="tabpanel"
      id="attachments-panel"
      aria-labelledby={`attachments-tab-${kind}`}
      aria-busy={loading}
    >
      {#if items.length > 0}
        {#each groups as group (group.key)}
          <section aria-labelledby={`attachments-month-${group.key}`}>
            <h3 class="group-heading" id={`attachments-month-${group.key}`}>{group.label}</h3>
            {#if kind === 'media'}
              <ul class="media-grid">
                {#each group.items as item (attachmentKey(item))}
                  <li>{@render mediaTile(item)}</li>
                {/each}
              </ul>
            {:else}
              <ul class="attachment-list">
                {#each group.items as item (attachmentKey(item))}
                  <li>{@render row(item)}</li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      {:else if loading}
        {@render skeleton()}
      {:else if showEmpty}
        <p class="attachments-status">{$i18n.t(emptyLabel)}</p>
      {/if}

      {#if failed}
        <div class="attachments-failure" role="alert">
          <p>{$i18n.t('timeline.attachmentsFailed')}</p>
          <Button size="small" variant="secondary" onclick={() => void load()}>
            {$i18n.t('timeline.attachmentsRetry')}
          </Button>
        </div>
      {:else if loading && items.length > 0}
        <div class="attachments-more"><Spinner small /></div>
      {:else if paused}
        <div class="attachments-more">
          <Button
            size="small"
            variant="secondary"
            onclick={() => {
              paused = false;
              loadMore();
            }}
          >
            {$i18n.t('timeline.attachmentsLoadMore')}
          </Button>
        </div>
      {:else if !exhausted && !loading}
        <div class="attachments-more" {@attach nearEnd}>
          <Button size="small" variant="secondary" onclick={loadMore}>
            {$i18n.t('timeline.attachmentsLoadMore')}
          </Button>
        </div>
      {/if}
    </div>
  </aside>
{/snippet}

{#if modal}
  <DialogFrame
    open
    onOpenChange={(open: boolean) => {
      if (!open) onClose();
    }}
    variant="drawer"
    label={$i18n.t('timeline.attachmentsTitle')}
  >
    {@render body()}
  </DialogFrame>
{:else}
  {@render body()}
{/if}

<style>
  .attachments {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-left: var(--border-width) solid var(--bg-container-line);
    display: grid;
    flex: 0 0 auto;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    min-height: 0;
    width: 22rem;
  }

  .attachments.modal {
    border-left: none;
    height: 100%;
    width: 100%;
  }

  .tabs {
    display: flex;
    gap: var(--space-100);
    padding: var(--space-300) var(--space-300) 0;
  }

  .tabs :global(.attachments-tab) {
    position: relative;
  }

  .tabs :global(.attachments-tab)::after {
    content: '';
    inset-block: calc((var(--button-height) - var(--target-hit)) / 2);
    inset-inline: 0;
    position: absolute;
  }

  .attachments-scope {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-200) var(--space-400) var(--space-300);
  }

  .attachments-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-block-end: var(--space-300);
    scroll-padding-block-start: var(--space-800);
  }

  .group-heading {
    background: var(--bg-container);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
    padding: var(--space-300) var(--space-400) var(--space-200);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  ul {
    list-style: none;
    margin: 0;
  }

  .media-grid {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: 0 var(--space-300);
  }

  .skeleton-grid {
    padding-block-start: var(--space-300);
  }

  .media-grid :global(.media-skeleton) {
    aspect-ratio: 1 / 1;
  }

  .media-tile {
    aspect-ratio: 1 / 1;
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: block;
    overflow: hidden;
    padding: 0;
    position: relative;
    width: 100%;
  }

  .media-tile :global(.tile-image) {
    height: 100%;
    width: 100%;
  }

  .media-tile:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .tile-placeholder {
    align-items: center;
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    height: 100%;
    justify-content: center;
    padding: var(--space-200);
  }

  .tile-placeholder :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .tile-placeholder-label {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    max-width: 100%;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .tile-badge {
    align-items: center;
    background: var(--surface-container);
    border-radius: 50%;
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    display: flex;
    inset-block-start: var(--space-100);
    inset-inline-end: var(--space-100);
    padding: var(--space-100);
    pointer-events: none;
    position: absolute;
  }

  .tile-meta {
    background: var(--surface-container);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    inset-block-end: 0;
    inset-inline: 0;
    opacity: 0;
    overflow: hidden;
    padding: var(--space-100) var(--space-200);
    pointer-events: none;
    position: absolute;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .media-tile:hover .tile-meta,
  .media-tile:focus-visible .tile-meta {
    opacity: 1;
  }

  @media (hover: none) {
    .tile-meta {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .tile-meta {
      transition: opacity var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .attachment-list {
    display: grid;
    padding: 0 var(--space-200);
  }

  .attachment-row {
    align-items: start;
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-300);
    padding: var(--space-200);
    text-align: start;
    width: 100%;
  }

  .attachment-row:hover {
    background: var(--bg-container-hover);
  }

  .attachment-row:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .attachment-row :global(.attachment-icon) {
    color: var(--surface-var-on-container);
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .attachment-text {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
  }

  .attachment-name {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-weight: var(--font-weight-medium);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .attachment-meta {
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: 0 var(--space-200);
    min-width: 0;
  }

  .attachment-sender {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-row {
    cursor: default;
  }

  .link-text {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .link-row :global(.link-jump) {
    flex: none;
  }

  .link-row:hover {
    background: none;
  }

  .link {
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    gap: var(--space-100);
    min-width: 0;
    text-decoration: none;
  }

  .link:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .link-host {
    color: var(--primary-main);
    flex: none;
    font-weight: var(--font-weight-medium);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link:hover .link-host,
  .link:focus-visible .link-host {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }

  .link-rest {
    color: var(--surface-var-on-container);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-more {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .row-skeletons {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-300) var(--space-400);
  }

  .row-skeleton {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  .row-skeleton :global(.row-skeleton-icon) {
    flex: none;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .row-skeleton-lines {
    display: grid;
    flex: 1;
    gap: var(--space-100);
  }

  .row-skeleton :global(.row-skeleton-line) {
    height: 0.75rem;
  }

  .row-skeleton :global(.row-skeleton-line.short) {
    width: 40%;
  }

  .attachments-status {
    color: var(--surface-var-on-container);
    margin: 0;
    padding: var(--space-400);
  }

  .attachments-failure {
    display: grid;
    gap: var(--space-200);
    justify-items: start;
    padding: var(--space-400);
  }

  .attachments-failure p {
    margin: 0;
  }

  .attachments-more {
    display: flex;
    justify-content: center;
    padding: var(--space-300);
  }
</style>
