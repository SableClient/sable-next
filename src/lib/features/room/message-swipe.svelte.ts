import { startSwipeGesture, updateSwipeGesture, type SwipeGesture } from '#lib/ui/swipe-gesture.js';

import { swipeAction, swipeOffset, type SwipeAction } from './message-swipe';
import { on } from 'svelte/events';

export interface MessageSwipeOptions {
  enabled: () => boolean;
  canEdit: () => boolean;
  onReply: () => void;
  onEdit: () => void;
}

const HAPTIC_MS: Record<Exclude<SwipeAction, 'none'>, number> = { reply: 5, edit: 12 };

interface Vibrates {
  vibrate?: (pattern: number) => boolean;
}

function scrollsSideways(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null;
  while (node !== null && node !== root) {
    if (node.scrollWidth > node.clientWidth) return true;
    node = node.parentElement;
  }
  return false;
}

export class MessageSwipe {
  offset = $state(0);
  action = $state<SwipeAction>('none');
  dragging = $state(false);

  #options: MessageSwipeOptions;
  #gesture: SwipeGesture | undefined;
  #width = 0;

  constructor(options: MessageSwipeOptions) {
    this.#options = options;
  }

  attach = (node: HTMLElement): (() => void) => {
    const start = (event: TouchEvent): void => {
      this.#reset();
      if (!this.#options.enabled() || scrollsSideways(event.target, node)) return;

      this.#gesture = startSwipeGesture(event, 0);
      this.#width = node.clientWidth;
    };

    const move = (event: TouchEvent): void => {
      if (!this.#gesture) return;

      const update = updateSwipeGesture(this.#gesture, event);
      if (!update) {
        this.#release(false);
        return;
      }
      if (update.mode !== 'horizontal') return;

      if (update.distanceX >= 0) {
        this.offset = 0;
        this.#arm('none');
        return;
      }

      const canEdit = this.#options.canEdit();
      if (event.cancelable) event.preventDefault();
      this.dragging = true;
      this.offset = swipeOffset(update.distanceX, this.#width, canEdit);
      this.#arm(swipeAction(update.distanceX, this.#width, canEdit));
    };

    const end = (): void => {
      this.#release(true);
    };
    const cancel = (): void => {
      this.#release(false);
    };

    const unsubscribers = [
      on(node, 'touchstart', start, { passive: true }),
      on(node, 'touchmove', move, { passive: false }),
      on(node, 'touchend', end, { passive: true }),
      on(node, 'touchcancel', cancel, { passive: true }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      this.#reset();
    };
  };

  #arm(next: SwipeAction): void {
    if (next === this.action) return;
    this.action = next;
    if (next === 'none') return;
    (navigator as Vibrates).vibrate?.(HAPTIC_MS[next]);
  }

  #release(commit: boolean): void {
    const action = this.action;
    this.#reset();
    if (!commit) return;

    if (action === 'edit') this.#options.onEdit();
    else if (action === 'reply') this.#options.onReply();
  }

  #reset(): void {
    this.#gesture = undefined;
    this.offset = 0;
    this.action = 'none';
    this.dragging = false;
  }
}
