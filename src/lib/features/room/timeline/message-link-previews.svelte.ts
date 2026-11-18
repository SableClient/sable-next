import type { TimelineItemView } from '#src/generated/protocol';

import { shownLinkPreviews } from '../media/link-preview-cache';
import { previewableLinks } from '../media/link-preview.js';
import { isMediaCaptionContent } from '../messages/media-caption.js';

export class MessageLinkPreviews {
  readonly #removed: boolean;
  readonly bundled: TimelineItemView['bundled_link_previews'];
  readonly urls: string[];

  constructor(item: () => TimelineItemView) {
    this.#removed = $derived(item().link_previews_removed === true);
    this.bundled = $derived(this.#removed ? [] : item().bundled_link_previews);
    this.urls = $derived.by(() => {
      if (this.#removed || this.bundled.length > 0) return [];
      const content = item().content;
      if (content.kind === 'message' || content.kind === 'gallery')
        return previewableLinks(content.html, content.body);
      if (isMediaCaptionContent(content) && content.caption !== null)
        return previewableLinks(content.html ?? '', content.caption).filter(
          (url) => url !== content.external_url
        );
      return [];
    });
  }

  get any(): boolean {
    return this.bundled.length > 0 || this.urls.length > 0;
  }

  get shown() {
    return this.bundled.length > 0
      ? this.bundled
      : this.urls.flatMap((url) => shownLinkPreviews.get(url) ?? []);
  }
}
