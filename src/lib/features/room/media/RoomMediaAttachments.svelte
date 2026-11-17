<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
  import FileVideoIcon from 'phosphor-svelte/lib/FileVideoIcon';
  import PlayIcon from 'phosphor-svelte/lib/PlayIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { formatDate } from '#lib/ui/date-time.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';
  import type { MediaItem } from '#lib/ui/media/media-viewer-types.js';

  import { memberName } from '../members/members';
  import RoomAttachmentFeed from './RoomAttachmentFeed.svelte';
  import {
    attachmentKey,
    attachmentLabel,
    closingJump,
    viewerFields,
    type RoomAttachmentOf,
    type TileProps,
  } from './room-attachments';
  import { RoomAttachmentsPager } from './room-attachments-pager.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onClose?: () => void;
  }

  let { roomId, members, modal = false, onJump, onClose }: Props = $props();

  type MediaAttachment = RoomAttachmentOf<'media'>;

  const STILL_MIMES = new Set(['image/gif', 'image/webp', 'image/apng', 'image/avif']);

  const pager = new RoomAttachmentsPager(useCoreClient(), 'media');

  let viewerItems = $derived(pager.items.map((item) => mediaItem(item)));

  function senderOf(item: MediaAttachment): string {
    return memberName(members, item.sender);
  }

  function mediaItem(item: MediaAttachment): MediaItem {
    const content = item.content;
    const shared = {
      ...viewerFields(item, senderOf(item)),
      filename: content.filename,
      source: content.source,
      mime: content.mime,
      width: content.width,
      height: content.height,
      blurhash: content.blurhash,
      thumbnail: content.thumbnail,
      spoiler: content.spoiler,
    };
    return content.kind === 'image'
      ? { ...shared, kind: 'image', size: null, animated: null }
      : { ...shared, kind: 'video', playback: null };
  }

  function open(item: MediaAttachment): void {
    mediaViewerState.openPanel(
      viewerItems,
      attachmentKey(item),
      closingJump(modal, onClose, onJump)
    );
  }

  function tileName(content: MediaAttachment['content']): string {
    if (content.spoiler !== null) {
      return content.spoiler
        ? i18n.t('timeline.attachmentsSpoilerReason', { reason: content.spoiler })
        : i18n.t('timeline.attachmentsSpoiler');
    }
    if (content.kind === 'video') {
      return i18n.t('timeline.attachmentsVideoNamed', { name: content.filename });
    }
    return content.filename;
  }
</script>

<RoomAttachmentFeed {pager} {roomId} layout="grid" empty="timeline.attachmentsMediaEmpty">
  {#snippet item(item: MediaAttachment, tile: TileProps | undefined)}
    {@const content = item.content}
    {@const hidden = content.spoiler !== null}
    {@const preview = content.kind === 'image' ? content.source : content.thumbnail}
    <button
      {...tile}
      type="button"
      class="media-tile"
      aria-label={attachmentLabel(item, tileName(content), senderOf(item))}
      onclick={() => {
        open(item);
      }}
    >
      {#if hidden}
        <span class="tile-placeholder">
          <EyeSlashIcon aria-hidden="true" />
          <span class="tile-placeholder-label">{tileName(content)}</span>
        </span>
      {:else if preview === null}
        <span class="tile-placeholder">
          <FileVideoIcon aria-hidden="true" />
          <span class="tile-placeholder-label">{i18n.t('timeline.attachmentsVideo')}</span>
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
  {/snippet}
</RoomAttachmentFeed>

<style>
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

  @media (any-hover: none) {
    .tile-meta {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .tile-meta {
      transition: opacity var(--duration-fast) var(--ease-smooth-out);
    }
  }
</style>
