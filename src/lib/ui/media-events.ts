import type { Attachment } from 'svelte/attachments';
import { on } from 'svelte/events';

export function mediaEvents(handlers: {
  load?: () => void;
  error?: () => void;
}): Attachment<HTMLElement> {
  return (node) => {
    const stops = Object.entries(handlers).map(([type, handler]) => on(node, type, handler));
    return () => {
      for (const stop of stops) stop();
    };
  };
}
