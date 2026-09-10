import { on } from 'svelte/events';

import type { BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { TIMELINE_LAYOUT } from './timeline-layout';

const AUTOSCROLL_BUTTON = 1;

type Gesture = 'none' | 'press' | 'wheel' | 'touch' | 'keys' | 'autoscroll';

interface TimelineHistoryControllerOptions {
  getBackwardPagination: () => BackwardPaginationState;
  isNearOldest: () => boolean;
  isScrolling: () => boolean;
  requestHistory: () => Promise<boolean>;
}

export interface HistoryDecisionInput {
  wanted: boolean;
  pagination: BackwardPaginationState;
  nearOldest: boolean;
  requestPending: boolean;
  msSinceRequest: number;
}

export type HistoryDecision = 'request' | 'wait' | 'stop';

export function nextHistoryDecision(input: HistoryDecisionInput): HistoryDecision {
  if (!input.wanted) return 'wait';
  if (input.pagination === 'end') return 'stop';
  if (!input.nearOldest) return 'stop';
  if (input.requestPending || input.pagination !== 'idle') return 'wait';
  if (input.msSinceRequest < TIMELINE_LAYOUT.historyRequestMinInterval) {
    return 'wait';
  }
  return 'request';
}

export class TimelineHistoryController {
  private destroyed = false;
  private historyRequestPending = false;
  private historyWanted = false;
  private historyInputArmed = true;
  private historyFillActive = false;
  private historyFillTimer: ReturnType<typeof setTimeout> | null = null;
  private historyLastRequestStartedAt = Number.NEGATIVE_INFINITY;
  private wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelGestureActive = false;
  private wheelUsesNativeScrollEnd = false;
  private gestureSawScroll = false;
  private autoscrollActive = false;
  private activeGesture: Gesture = 'none';
  private readonly wheelHandler = (event: WheelEvent): void => {
    this.markWheelScroll(event);
  };
  private readonly wheelEndHandler = (): void => {
    this.markWheelScrollEnd();
  };
  private readonly touchStartHandler = (event: TouchEvent): void => {
    this.markTouchStart(event);
  };
  private readonly touchMoveHandler = (event: TouchEvent): void => {
    this.markTouchMove(event);
  };
  private readonly touchEndHandler = (): void => {
    this.markTouchEnd();
  };
  private readonly pointerStartHandler = (event: PointerEvent): void => {
    this.markPointerStart(event.button);
  };
  private readonly pointerEndHandler = (): void => {
    this.markPointerEnd();
  };
  private readonly autoscrollEndHandler = (): void => {
    this.finishAutoscrollGesture();
  };
  private readonly keyHandler = (event: KeyboardEvent): void => {
    this.finishAutoscrollGesture();
    this.markKeyScroll(event);
  };
  private readonly keyEndHandler = (event: KeyboardEvent): void => {
    this.markKeyEnd(event);
  };

  constructor(private readonly options: TimelineHistoryControllerOptions) {}

  get isRequestPending(): boolean {
    return this.historyRequestPending;
  }

  clearUserScrollPending(): void {
    if (this.destroyed) return;
    this.gestureSawScroll = true;
    this.activeGesture = 'none';
  }

  onScrollSettled(): void {
    if (this.destroyed) return;
    this.flushHistoryRequest();
    this.finishWheelGesture();
  }

  queueHistoryRequest(): void {
    if (this.destroyed) return;
    if (!this.historyWanted) {
      this.historyWanted = true;
    }
    this.flushHistoryRequest();
  }

  observeScroll(movedAway: boolean, nearLatest: boolean): void {
    if (this.destroyed) return;
    if (this.options.isNearOldest() && (movedAway || !nearLatest)) this.historyWanted = true;
    this.flushHistoryRequest();
  }

  beginHistoryFill(): void {
    if (this.destroyed) return;
    this.cancelHistoryFillTimer();
    this.historyFillActive = true;
    this.historyInputArmed = false;
  }

  finishHistoryFill(): void {
    if (this.destroyed) return;
    this.cancelHistoryFillTimer();
    this.historyFillActive = false;
    this.historyInputArmed = true;
  }

  requestHistoryIfNeeded(): void {
    if (this.destroyed) return;
    const decision = nextHistoryDecision(this.decisionInput());
    if (decision !== 'request') return;
    if (!this.historyFillActive) this.beginHistoryFill();
    this.historyInputArmed = false;
    this.requestHistory();
  }

  private decisionInput(): HistoryDecisionInput {
    return {
      wanted: this.historyWanted || this.historyFillActive,
      pagination: this.options.getBackwardPagination(),
      nearOldest: this.options.isNearOldest(),
      requestPending: this.historyRequestPending,
      msSinceRequest: performance.now() - this.historyLastRequestStartedAt,
    };
  }

  private fillDecisionInput(): HistoryDecisionInput {
    return { ...this.decisionInput(), msSinceRequest: Number.POSITIVE_INFINITY };
  }

  markWheelScroll(event: WheelEvent): void {
    if (this.destroyed) return;
    this.finishAutoscrollGesture();
    if (this.wheelGestureTimer !== null) clearTimeout(this.wheelGestureTimer);
    this.wheelGestureTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.wheelGestureTimer = null;
      if (!this.wheelUsesNativeScrollEnd || !this.gestureSawScroll || !this.options.isScrolling()) {
        this.finishWheelGesture();
      }
    }, TIMELINE_LAYOUT.wheelGestureEndDelay);
    if (!this.wheelGestureActive) this.gestureSawScroll = false;
    this.wheelGestureActive = true;
    this.activeGesture = 'wheel';
    if (event.deltaY < 0 && this.historyInputArmed) {
      this.queueHistoryRequest();
    } else if (event.deltaY >= 0) {
      this.finishHistoryFill();
      this.historyWanted = false;
    }
  }

  finishWheelGesture(): void {
    if (this.destroyed) return;
    if (!this.wheelGestureActive) return;
    this.wheelGestureActive = false;
    if (this.activeGesture === 'wheel') this.activeGesture = 'none';
    this.flushHistoryRequest();
    if (!this.historyFillActive) this.historyInputArmed = true;
  }

  markWheelScrollEnd(): void {
    if (this.destroyed) return;
    if (this.wheelGestureTimer !== null) {
      clearTimeout(this.wheelGestureTimer);
      this.wheelGestureTimer = null;
    }
    this.finishWheelGesture();
  }

  markKeyScroll(event: KeyboardEvent): void {
    if (this.destroyed) return;
    const upward = event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home';
    const scrollKey =
      upward ||
      event.key === 'ArrowDown' ||
      event.key === 'PageDown' ||
      event.key === 'End' ||
      event.key === ' ';
    if (!scrollKey) return;
    this.activeGesture = 'keys';
    if (upward && this.historyInputArmed) {
      this.queueHistoryRequest();
    } else if (!upward) {
      this.finishHistoryFill();
      this.historyWanted = false;
    }
  }

  markKeyEnd(event: KeyboardEvent): void {
    if (this.destroyed) return;
    if (event.key !== 'ArrowUp' && event.key !== 'PageUp' && event.key !== 'Home') return;
    this.historyInputArmed = true;
    this.flushHistoryRequest();
  }

  markTouchStart(event: TouchEvent): void {
    if (this.destroyed) return;
    this.activeGesture = 'touch';
    this.historyInputArmed = true;
    this.lastTouchY = event.touches.item(0)?.clientY ?? null;
  }

  markTouchMove(event: TouchEvent): void {
    if (this.destroyed) return;
    const touchY = event.touches.item(0)?.clientY;
    if (touchY === undefined || this.lastTouchY === null) return;
    this.activeGesture = 'touch';
    const upward = touchY > this.lastTouchY;
    this.lastTouchY = touchY;
    if (upward) this.queueHistoryRequest();
    else this.historyWanted = false;
  }

  markTouchEnd(): void {
    if (this.destroyed) return;
    this.lastTouchY = null;
    this.historyInputArmed = true;
    this.flushHistoryRequest();
  }

  markPointerStart(button = 0): void {
    if (this.destroyed) return;
    if (this.autoscrollActive) {
      this.finishAutoscrollGesture();
      return;
    }
    if (button === AUTOSCROLL_BUTTON) {
      this.autoscrollActive = true;
      this.activeGesture = 'autoscroll';
      this.historyInputArmed = true;
      return;
    }
    this.activeGesture = 'press';
  }

  markPointerEnd(): void {
    if (this.destroyed) return;
    if (this.activeGesture === 'press') this.activeGesture = 'none';
  }

  finishAutoscrollGesture(): void {
    if (this.destroyed) return;
    if (!this.autoscrollActive) return;
    this.autoscrollActive = false;
    if (this.activeGesture === 'autoscroll') this.activeGesture = 'none';
    this.historyInputArmed = true;
    this.flushHistoryRequest();
  }

  attach(node: HTMLDivElement): () => void {
    if (this.destroyed) return () => {};
    this.wheelUsesNativeScrollEnd = 'onscrollend' in node;
    const unsubscribers = [
      on(node, 'wheel', this.wheelHandler, { passive: true }),
      on(node, 'scrollend', this.wheelEndHandler),
      on(node, 'touchstart', this.touchStartHandler, { passive: true }),
      on(node, 'touchmove', this.touchMoveHandler, { passive: true }),
      on(node, 'touchend', this.touchEndHandler),
      on(node, 'touchcancel', this.touchEndHandler),
      on(node, 'pointerdown', this.pointerStartHandler, { passive: true }),
      on(node, 'pointerup', this.pointerEndHandler, { passive: true }),
      on(node, 'pointercancel', this.pointerEndHandler, { passive: true }),
      on(node, 'keydown', this.keyHandler),
      on(node, 'blur', this.autoscrollEndHandler),
      on(node, 'keyup', this.keyEndHandler),
    ];

    return () => {
      this.destroy();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelHistoryFillTimer();
    if (this.wheelGestureTimer !== null) clearTimeout(this.wheelGestureTimer);
    this.wheelGestureTimer = null;
    this.historyRequestPending = false;
    this.historyWanted = false;
    this.historyFillActive = false;
    this.wheelGestureActive = false;
    this.autoscrollActive = false;
    this.activeGesture = 'none';
    this.lastTouchY = null;
  }

  private lastTouchY: number | null = null;

  private flushHistoryRequest(): void {
    this.requestHistoryIfNeeded();
  }

  private requestHistory(): void {
    if (
      this.destroyed ||
      this.historyRequestPending ||
      this.options.getBackwardPagination() !== 'idle'
    )
      return;
    this.historyWanted = false;
    this.historyRequestPending = true;
    this.historyLastRequestStartedAt = performance.now();
    void this.options.requestHistory().then(
      (reachedEnd) => {
        if (this.destroyed) return;
        this.historyRequestPending = false;
        if (reachedEnd) this.finishHistoryFill();
        else this.scheduleHistoryFill();
      },
      () => {
        if (this.destroyed) return;
        this.historyRequestPending = false;
        this.finishHistoryFill();
      }
    );
  }

  private scheduleHistoryFill(): void {
    if (this.destroyed) return;
    this.cancelHistoryFillTimer();
    if (!this.historyFillActive) return;
    if (nextHistoryDecision(this.fillDecisionInput()) === 'stop') {
      this.finishHistoryFill();
      return;
    }
    const delay = Math.max(
      0,
      this.historyLastRequestStartedAt +
        TIMELINE_LAYOUT.historyRequestMinInterval -
        performance.now()
    );
    this.historyFillTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.continueHistoryFill();
    }, delay);
  }

  private continueHistoryFill(): void {
    if (this.destroyed) return;
    this.historyFillTimer = null;
    if (!this.historyFillActive) return;
    const decision = nextHistoryDecision(this.fillDecisionInput());
    if (decision === 'stop') {
      this.finishHistoryFill();
      return;
    }
    if (decision === 'request') {
      this.requestHistory();
      return;
    }
    this.historyFillTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.continueHistoryFill();
    }, 50);
  }

  private cancelHistoryFillTimer(): void {
    if (this.historyFillTimer === null) return;
    clearTimeout(this.historyFillTimer);
    this.historyFillTimer = null;
  }
}
