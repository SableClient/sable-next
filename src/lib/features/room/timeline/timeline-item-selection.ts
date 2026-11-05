import { copyText } from '#lib/platform/clipboard.js';
import { i18n } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import type { MessageActions } from '../messages/message-menu-items.js';

export function selectedText(row: HTMLElement | null): string {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !row) return '';
  if (!row.contains(selection.anchorNode) || !row.contains(selection.focusNode)) {
    return '';
  }
  return selection.toString();
}

export function withSelectedText(base: MessageActions, text: string): MessageActions {
  if (!text) return base;
  return {
    ...base,
    onCopyText: () => {
      void copyText(text)
        .then(() => toasts.info(i18n.t('common.copied')))
        .catch(() => toasts.error(i18n.t('errors.actionFailed')));
    },
    copyTextLabel: 'timeline.copySelection',
  };
}
