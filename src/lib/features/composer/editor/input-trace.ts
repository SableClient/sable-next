import { recordDebugLog } from '#lib/observability/debug-log.svelte.js';

const TRACED = ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend'] as const;

function newlines(text: string | null | undefined): number {
  return text?.match(/\r?\n/g)?.length ?? 0;
}

function describe(event: Event, node: HTMLElement): Record<string, unknown> {
  const shape = {
    paragraphs: node.querySelectorAll('p').length,
    breaks: node.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length,
  };
  if (event instanceof KeyboardEvent) {
    return {
      key: event.key,
      code: event.code,
      composing: event.isComposing,
      prevented: event.defaultPrevented,
      ...shape,
    };
  }
  if (event instanceof InputEvent) {
    return {
      inputType: event.inputType,
      cancelable: event.cancelable,
      prevented: event.defaultPrevented,
      length: event.data?.length ?? 0,
      newlines: newlines(event.data),
      ...shape,
    };
  }
  if (event instanceof CompositionEvent) {
    return { length: event.data.length, newlines: newlines(event.data), ...shape };
  }
  return shape;
}

export function traceComposerInput(node: HTMLElement): () => void {
  const listener = (event: Event): void => {
    queueMicrotask(() => {
      recordDebugLog('debug', 'ui', 'composer-input', event.type, describe(event, node));
    });
  };
  for (const type of TRACED) node.addEventListener(type, listener, true);
  return () => {
    for (const type of TRACED) node.removeEventListener(type, listener, true);
  };
}
