import { createAttachmentKey } from 'svelte/attachments';

const stack: Element[] = [];
const detached = new Set<Element>();
const depths = new Set<number>();
let element: HTMLStyleElement | null = null;

function raise(depth: number): void {
  if (depths.has(depth)) return;
  depths.add(depth);
  element ??= document.head.appendChild(document.createElement('style'));
  element.textContent += `[data-overlay-depth="${String(depth)}"] { z-index: calc(var(--layer-overlay) + ${String(depth)}); }\n`;
}

function stamp(): void {
  stack.forEach((node, index) => {
    raise(index + 1);
    node.setAttribute('data-overlay-depth', String(index + 1));
  });
}

export function overlayLayer(): Record<symbol, (node: Element) => () => void> {
  return {
    [createAttachmentKey()]: (node: Element) => {
      detached.delete(node);
      if (!stack.includes(node)) stack.push(node);
      stamp();

      return () => {
        detached.add(node);
        queueMicrotask(() => {
          if (!detached.delete(node)) return;
          stack.splice(stack.indexOf(node), 1);
          stamp();
        });
      };
    },
  };
}
