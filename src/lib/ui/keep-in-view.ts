import type { Attachment } from 'svelte/attachments';

/** Scrolls the `data-index` child that `index` names into view whenever it changes. */
export function keepInView(index: () => number): Attachment<HTMLElement> {
  return (node) => {
    node.querySelector(`[data-index="${String(index())}"]`)?.scrollIntoView({ block: 'nearest' });
  };
}
