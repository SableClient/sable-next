<script lang="ts">
  import type { Component } from 'svelte';
  import type { MemberView } from '#src/generated/protocol';
  import FileAudioIcon from 'phosphor-svelte/lib/FileAudioIcon';
  import FileIcon from 'phosphor-svelte/lib/FileIcon';
  import FileImageIcon from 'phosphor-svelte/lib/FileImageIcon';
  import FilePdfIcon from 'phosphor-svelte/lib/FilePdfIcon';
  import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
  import FileVideoIcon from 'phosphor-svelte/lib/FileVideoIcon';
  import FileZipIcon from 'phosphor-svelte/lib/FileZipIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';
  import type { MediaItem } from '#lib/ui/media/media-viewer-types.js';

  import { memberName } from '../members/members';
  import AttachmentMeta from './AttachmentMeta.svelte';
  import RoomAttachmentFeed from './RoomAttachmentFeed.svelte';
  import {
    attachmentKey,
    attachmentLabel,
    closingJump,
    viewerFields,
    type RoomAttachmentOf,
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

  type FileAttachment = RoomAttachmentOf<'file'>;

  const pager = new RoomAttachmentsPager(useCoreClient(), 'file');

  let viewerItems = $derived(pager.items.map((item) => mediaItem(item)));

  function senderOf(item: FileAttachment): string {
    return memberName(members, item.sender);
  }

  function mediaItem(item: FileAttachment): MediaItem {
    const content = item.content;
    const shared = {
      ...viewerFields(item, senderOf(item)),
      filename: content.filename,
      source: content.source,
      mime: content.mime,
    };
    return content.mime?.startsWith('audio/')
      ? {
          ...shared,
          kind: 'audio',
          duration_ms: null,
          waveform: null,
          voice: false,
          metadata: null,
        }
      : { ...shared, kind: 'file', size: content.size };
  }

  function open(item: FileAttachment): void {
    mediaViewerState.openPanel(
      viewerItems,
      attachmentKey(item),
      closingJump(modal, onClose, onJump)
    );
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
</script>

<RoomAttachmentFeed {pager} {roomId} layout="rows" empty="timeline.attachmentsFilesEmpty">
  {#snippet item(item: FileAttachment)}
    {@const content = item.content}
    {@const Icon = fileIcon(content.mime)}
    <button
      type="button"
      class="attachment-row"
      aria-label={attachmentLabel(item, content.filename, senderOf(item))}
      onclick={() => {
        open(item);
      }}
    >
      <Icon class="attachment-icon" aria-hidden="true" />
      <span class="attachment-text">
        <span class="attachment-name">{content.filename}</span>
        <AttachmentMeta sender={senderOf(item)} timestamp={item.timestamp} size={content.size} />
      </span>
    </button>
  {/snippet}
</RoomAttachmentFeed>

<style>
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
</style>
