import type { BackwardPaginationState } from '#lib/rooms/timeline.svelte.js';

import { TIMELINE_LAYOUT } from './timeline-layout';
import { isScrolling, type Gesture } from './timeline-position';

const AUTOSCROLL_BUTTON = 1;
import { on } from 'svelte/events';

interface TimelineHistoryControllerOptions {
  getBackwardPagination: () => BackwardPaginationState;
  isNearOldest: () => boolean;
  isVirtualizerScrolling: () => boolean;
  requestHistory: () => Promise<boolean>;
  onGestureSettled: () => void;
  debugLog: (event: string, details: object) => void;
  debugSnapshot: () => object | null;
}

const ANCHOR_FAILURE_LIMIT = 2;

const ANCHOR_RESIDUAL_TOLERANCE = 2;

export interface HistoryDecisionInput {
  wanted: boolean;
  pagination: BackwardPaginationState;
  nearOldest: boolean;
  requestPending: boolean;
  anchorSuppressed: boolean;
  anchorFailing: boolean;
  pagesRequested: number;
  msSinceRequest: number;
}

export type HistoryDecision = 'request' | 'defer' | 'wait' | 'stop';

export function nextHistoryDecision(input: HistoryDecisionInput): HistoryDecision {
  if (!input.wanted) return 'wait';
  if (input.pagination === 'end') return 'stop';
  if (input.anchorFailing) return 'stop';
  if (input.pagesRequested >= TIMELINE_LAYOUT.historyFillMaxPages) return 'stop';
  if (input.anchorSuppressed) return 'defer';
  if (!input.nearOldest) return 'stop';
  if (input.requestPending || input.pagination !== 'idle') return 'wait';
  if (
    input.pagesRequested > 0 &&
    input.msSinceRequest < TIMELINE_LAYOUT.historyRequestMinInterval
  ) {
    return 'wait';
  }
  return 'request';
}

export class TimelineHistoryController {
  private destroyed = false;
  private historyRequestPending = false;
  private historyWanted = false;
  private anchorSuppressed = false;
  private anchorDeferredRequest = false;
  private anchorFailures = 0;
  private historyInputArmed = true;
  private historyFillActive = false;
  private historyFillPages = 0;
  private historyFillTimer: ReturnType<typeof setTimeout> | null = null;
  private historyLastRequestStartedAt = Number.NEGATIVE_INFINITY;
  private wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelGestureActive = false;
  private wheelUsesNativeScrollEnd = false;
  private gestureSawScroll = false;
  private autoscrollActive = false;
  /** Any scroll clears this, so a gesture still set here has not moved anything. */
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

  get gesture(): Gesture {
    return this.activeGesture === 'none' && this.autoscrollActive
      ? 'autoscroll'
      : this.activeGesture;
  }

  get isScrollGestureActive(): boolean {
    return isScrolling(this.gesture);
  }

  get isRequestPending(): boolean {
    return this.historyRequestPending;
  }

  clearUserScrollPending(): void {
    if (this.destroyed) return;
    this.gestureSawScroll = true;
    this.activeGesture = 'none';
  }

  get isAnchorFailing(): boolean {
    return this.anchorFailures >= ANCHOR_FAILURE_LIMIT;
  }

  suspendForAnchor(): void {
    if (this.destroyed) return;
    this.anchorSuppressed = true;
  }

  resumeAfterAnchor(residual: number | null): void {
    if (this.destroyed) return;
    this.anchorSuppressed = false;
    if (this.historyFillActive) {
      if (residual === null || Math.abs(residual) > ANCHOR_RESIDUAL_TOLERANCE) {
        this.anchorFailures += 1;
      } else {
        this.anchorFailures = 0;
      }
    }
    if (this.anchorDeferredRequest) {
      this.anchorDeferredRequest = false;
      this.historyWanted = true;
    }
    this.flushHistoryRequest();
  }

  resetForNewItems(firstKeyChanged: boolean): void {
    if (this.destroyed) return;
    if (!firstKeyChanged) return;
    this.historyWanted = false;
  }

  onVirtualizerScrollSettled(): void {
    if (this.destroyed) return;
    this.flushHistoryRequest();
    this.finishWheelGesture();
  }

  queueHistoryRequest(): void {
    if (this.destroyed) return;
    if (!this.historyWanted) {
      this.historyWanted = true;
      this.options.debugLog('history:wanted', {
        pagination: this.options.getBackwardPagination(),
        viewport: this.options.debugSnapshot(),
      });
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
    this.historyFillPages = 0;
    this.historyInputArmed = false;
  }

  finishHistoryFill(): void {
    if (this.destroyed) return;
    this.cancelHistoryFillTimer();
    this.historyFillActive = false;
    this.historyFillPages = 0;
    this.anchorFailures = 0;
    this.historyInputArmed = true;
  }

  requestHistoryIfNeeded(): void {
    if (this.destroyed) return;
    const decision = nextHistoryDecision(this.decisionInput());
    if (decision === 'defer') {
      this.anchorDeferredRequest = true;
      return;
    }
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
      anchorSuppressed: this.anchorSuppressed,
      anchorFailing: this.isAnchorFailing,
      pagesRequested: this.historyFillActive ? this.historyFillPages : 0,
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
      if (
        !this.wheelUsesNativeScrollEnd ||
        !this.gestureSawScroll ||
        !this.options.isVirtualizerScrolling()
      ) {
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
    this.options.onGestureSettled();
    this.options.debugLog('gesture:settled', {
      wanted: this.historyWanted,
      pagination: this.options.getBackwardPagination(),
      isScrolling: this.options.isVirtualizerScrolling(),
      viewport: this.options.debugSnapshot(),
    });
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
    this.options.onGestureSettled();
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
    this.options.onGestureSettled();
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
    this.options.onGestureSettled();
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
    this.historyFillPages = 0;
    this.wheelGestureActive = false;
    this.autoscrollActive = false;
    this.activeGesture = 'none';
    this.anchorSuppressed = false;
    this.anchorDeferredRequest = false;
    this.anchorFailures = 0;
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
    this.historyFillPages += 1;
    this.historyLastRequestStartedAt = performance.now();
    this.options.debugLog('request:start', {
      pagination: this.options.getBackwardPagination(),
      viewport: this.options.debugSnapshot(),
    });
    void this.options.requestHistory().then(
      (reachedEnd) => {
        if (this.destroyed) return;
        this.historyRequestPending = false;
        this.options.debugLog('request:settled', {
          pagination: this.options.getBackwardPagination(),
          viewport: this.options.debugSnapshot(),
        });
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
    if (decision === 'defer') this.anchorDeferredRequest = true;
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
