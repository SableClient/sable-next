import type { Attachment } from 'svelte/attachments';

import { highlightSegments } from './highlight';

const HIGHLIGHT = 'search-match';

function termRanges(root: Node, terms: readonly string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    let offset = 0;
    for (const segment of highlightSegments(text, terms)) {
      if (segment.match) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + segment.text.length);
        ranges.push(range);
      }
      offset += segment.text.length;
    }
  }
  return ranges;
}

export function markTerms(terms: readonly string[]): Attachment<HTMLElement> {
  return (node) => {
    if (typeof CSS === 'undefined' || !('highlights' in CSS) || terms.length === 0) return;
    const highlight = CSS.highlights.get(HIGHLIGHT) ?? new Highlight();
    CSS.highlights.set(HIGHLIGHT, highlight);

    let ranges: Range[] = [];
    const apply = (): void => {
      for (const range of ranges) highlight.delete(range);
      ranges = termRanges(node, terms);
      for (const range of ranges) highlight.add(range);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(node, { subtree: true, childList: true, characterData: true });

    return () => {
      observer.disconnect();
      for (const range of ranges) highlight.delete(range);
    };
  };
}
