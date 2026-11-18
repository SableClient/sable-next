import type { TimelineItemView } from '#src/generated/protocol';

import { i18n } from '#lib/i18n.js';

export interface MessageTransferOptions {
  item: TimelineItemView;
  pending: boolean;
  savingPercent: number | null;
  savingSlow: boolean;
  onCancel: () => void;
}

export class MessageTransfer {
  readonly #options: () => MessageTransferOptions;

  constructor(options: () => MessageTransferOptions) {
    this.#options = options;
  }

  readonly upload = $derived.by(() => {
    const { send_state } = this.#options().item;
    return send_state?.status === 'sending' ? (send_state.progress ?? null) : null;
  });

  readonly #uploading = $derived.by(() => {
    const { item, pending } = this.#options();
    return (
      pending &&
      (item.content.kind === 'image' ||
        item.content.kind === 'video' ||
        item.content.kind === 'audio' ||
        item.content.kind === 'file' ||
        item.content.kind === 'gallery')
    );
  });

  readonly #galleryCount = $derived.by(() => {
    const { content } = this.#options().item;
    return content.kind === 'gallery' ? content.items.length : 0;
  });

  readonly props = $derived.by(() => {
    const { item, savingPercent, savingSlow, onCancel: cancel } = this.#options();
    const onCancel = item.transaction_id ? cancel : undefined;
    const upload = this.upload;
    if (upload !== null) {
      const part = upload.total > 0 ? Math.min(1, upload.current / upload.total) : 0;
      const galleryCount = this.#galleryCount;
      const gallery = galleryCount > 1;
      return {
        label: i18n.t('timeline.uploading'),
        max: 1,
        value: gallery ? Math.min(1, (upload.index + part) / galleryCount) : part,
        count: gallery
          ? i18n.t('timeline.uploadingItem', {
              current: Math.min(upload.index + 1, galleryCount),
              count: galleryCount,
            })
          : null,
        onCancel,
      };
    }
    if (this.#uploading) return { label: i18n.t('timeline.uploading'), onCancel };
    if (savingPercent !== null)
      return { label: i18n.t('timeline.downloading'), max: 100, value: savingPercent };
    if (savingSlow) return { label: i18n.t('timeline.downloading') };
    return null;
  });
}
