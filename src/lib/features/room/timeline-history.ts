import type { BackwardPaginationState } from '$lib/rooms/timeline.svelte';

import { TIMELINE_LAYOUT } from './timeline-layout';

interface TimelineHistoryControllerOptions {
  getBackwardPagination: () => BackwardPaginationState;
  isNearOldest: () => boolean;
  isVirtualizerScrolling: () => boolean;
  requestHistory: () => Promise<boolean>;
  /** A gesture that could not scroll leaves work the scroll handler never sees. */
  onGestureSettled: () => void;
  debugLog: (event: string, details: object) => void;
  debugSnapshot: () => object | null;
}

const ANCHOR_FAILURE_LIMIT = 2;

const ANCHOR_RESIDUAL_TOLERANCE = 2;

export class TimelineHistoryController {
  private destroyed = false;
  private historyRequestPending = false;
  private historyRequestQueued = false;
  private historyRequestEligible = false;
  private anchorSuppressed = false;
  private anchorDeferredRequest = false;
  private anchorFailures = 0;
  private historyInputArmed = true;
  private historyFillActive = false;
  private historyFillPages = 0;
  private historyFillTimer: ReturnType<typeof setTimeout> | null = null;
  private historyLastRequestStartedAt = 0;
  private wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelGestureActive = false;
  private wheelUsesNativeScrollEnd = false;
  private gestureSawScroll = false;
  private userScrollPending = false;
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
  private readonly pointerStartHandler = (): void => {
    this.markPointerStart();
  };
  private readonly pointerEndHandler = (): void => {
    this.markPointerEnd();
  };
  private readonly keyHandler = (event: KeyboardEvent): void => {
    this.markKeyScroll(event);
  };
  private readonly keyEndHandler = (event: KeyboardEvent): void => {
    this.markKeyEnd(event);
  };

  constructor(private readonly options: TimelineHistoryControllerOptions) {}

  get hasUserScrollPending(): boolean {
    return this.userScrollPending;
  }

  get isRequestPending(): boolean {
    return this.historyRequestPending;
  }

  clearUserScrollPending(): void {
    if (this.destroyed) return;
    this.gestureSawScroll = true;
    this.userScrollPending = false;
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
    if (residual === null || Math.abs(residual) > ANCHOR_RESIDUAL_TOLERANCE) {
      this.anchorFailures += 1;
    } else {
      this.anchorFailures = 0;
    }
    if (this.anchorDeferredRequest) {
      this.anchorDeferredRequest = false;
      this.historyRequestQueued = true;
      this.historyRequestEligible = true;
    }
    this.flushHistoryRequest();
  }

  resetForNewItems(firstKeyChanged: boolean): void {
    if (this.destroyed) return;
    if (!firstKeyChanged) return;
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
  }

  onVirtualizerScrollSettled(): void {
    if (this.destroyed) return;
    this.flushHistoryRequest();
    this.finishWheelGesture();
  }

  queueHistoryRequest(): void {
    if (this.destroyed) return;
    const wasEligible = this.historyRequestEligible;
    this.historyRequestQueued = true;
    this.historyRequestEligible ||= this.options.isNearOldest();
    if (!wasEligible && this.historyRequestEligible) {
      this.options.debugLog('gesture:eligible', {
        pagination: this.options.getBackwardPagination(),
        viewport: this.options.debugSnapshot(),
      });
    }
    this.flushHistoryRequest();
  }

  refreshQueuedRequest(): void {
    if (this.destroyed) return;
    if (this.historyRequestQueued) this.queueHistoryRequest();
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
    this.historyInputArmed = true;
  }

  requestHistoryIfNeeded(): void {
    if (this.destroyed) return;
    if (!this.historyRequestQueued || !this.historyRequestEligible || this.historyRequestPending) {
      return;
    }
    if (this.anchorSuppressed) {
      this.anchorDeferredRequest = true;
      return;
    }
    if (this.options.getBackwardPagination() !== 'idle' || !this.options.isNearOldest()) {
      return;
    }
    if (!this.historyFillActive) this.beginHistoryFill();
    this.historyInputArmed = false;
    this.requestHistory();
  }

  requestHistoryNow(): void {
    if (this.destroyed) return;
    this.requestHistory();
  }

  markWheelScroll(event: WheelEvent): void {
    if (this.destroyed) return;
    if (this.wheelGestureTimer !== null) clearTimeout(this.wheelGestureTimer);
    this.wheelGestureTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.wheelGestureTimer = null;
      // Without a scroll there is no `scrollend` to wait for, and the gesture
      // would never settle.
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
    this.userScrollPending = true;
    if (event.deltaY < 0 && this.historyInputArmed) {
      this.queueHistoryRequest();
    } else if (event.deltaY >= 0) {
      this.finishHistoryFill();
      this.historyRequestQueued = false;
      this.historyRequestEligible = false;
    }
  }

  finishWheelGesture(): void {
    if (this.destroyed) return;
    if (!this.wheelGestureActive) return;
    this.wheelGestureActive = false;
    this.options.onGestureSettled();
    this.options.debugLog('gesture:settled', {
      queued: this.historyRequestQueued,
      eligible: this.historyRequestEligible,
      pagination: this.options.getBackwardPagination(),
      isScrolling: this.options.isVirtualizerScrolling(),
      viewport: this.options.debugSnapshot(),
    });
    if (this.historyRequestQueued) this.flushHistoryRequest();
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
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
    this.userScrollPending = true;
    if (upward && this.historyInputArmed) {
      this.queueHistoryRequest();
    } else if (!upward) {
      this.finishHistoryFill();
      this.historyRequestQueued = false;
      this.historyRequestEligible = false;
    }
  }

  markKeyEnd(event: KeyboardEvent): void {
    if (this.destroyed) return;
    this.options.onGestureSettled();
    if (event.key !== 'ArrowUp' && event.key !== 'PageUp' && event.key !== 'Home') return;
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
    this.historyInputArmed = true;
  }

  markTouchStart(event: TouchEvent): void {
    if (this.destroyed) return;
    this.userScrollPending = true;
    this.historyInputArmed = true;
    this.lastTouchY = event.touches.item(0)?.clientY ?? null;
  }

  markTouchMove(event: TouchEvent): void {
    if (this.destroyed) return;
    const touchY = event.touches.item(0)?.clientY;
    if (touchY === undefined || this.lastTouchY === null) return;
    this.userScrollPending = true;
    const upward = touchY > this.lastTouchY;
    this.lastTouchY = touchY;
    if (upward) this.queueHistoryRequest();
    else this.historyRequestQueued = false;
  }

  markTouchEnd(): void {
    if (this.destroyed) return;
    this.options.onGestureSettled();
    this.lastTouchY = null;
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
    this.historyInputArmed = true;
  }

  markPointerStart(): void {
    if (this.destroyed) return;
    this.userScrollPending = true;
  }

  markPointerEnd(): void {
    if (this.destroyed) return;
    this.userScrollPending = false;
  }

  attach(node: HTMLDivElement): () => void {
    if (this.destroyed) return () => {};
    this.wheelUsesNativeScrollEnd = 'onscrollend' in node;
    node.addEventListener('wheel', this.wheelHandler, { passive: true });
    node.addEventListener('scrollend', this.wheelEndHandler);
    node.addEventListener('touchstart', this.touchStartHandler, { passive: true });
    node.addEventListener('touchmove', this.touchMoveHandler, { passive: true });
    node.addEventListener('touchend', this.touchEndHandler);
    node.addEventListener('touchcancel', this.touchEndHandler);
    node.addEventListener('pointerdown', this.pointerStartHandler, { passive: true });
    node.addEventListener('pointerup', this.pointerEndHandler, { passive: true });
    node.addEventListener('pointercancel', this.pointerEndHandler, { passive: true });
    node.addEventListener('keydown', this.keyHandler);
    node.addEventListener('keyup', this.keyEndHandler);
    return () => {
      this.detach(node);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelHistoryFillTimer();
    if (this.wheelGestureTimer !== null) clearTimeout(this.wheelGestureTimer);
    this.wheelGestureTimer = null;
    this.historyRequestPending = false;
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
    this.historyFillActive = false;
    this.historyFillPages = 0;
    this.wheelGestureActive = false;
    this.userScrollPending = false;
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
    this.historyRequestQueued = false;
    this.historyRequestEligible = false;
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
    if (
      !this.historyFillActive ||
      this.isAnchorFailing ||
      this.historyFillPages >= TIMELINE_LAYOUT.historyFillMaxPages ||
      this.options.getBackwardPagination() === 'end' ||
      !this.options.isNearOldest()
    ) {
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
    if (!this.historyFillActive || this.isAnchorFailing || !this.options.isNearOldest()) {
      this.finishHistoryFill();
      return;
    }
    if (
      this.anchorSuppressed ||
      this.historyRequestPending ||
      this.options.getBackwardPagination() === 'loading'
    ) {
      this.historyFillTimer = setTimeout(() => {
        if (this.destroyed) return;
        this.continueHistoryFill();
      }, 50);
      return;
    }
    if (this.options.getBackwardPagination() !== 'idle') {
      this.finishHistoryFill();
      return;
    }
    this.requestHistory();
  }

  private cancelHistoryFillTimer(): void {
    if (this.historyFillTimer === null) return;
    clearTimeout(this.historyFillTimer);
    this.historyFillTimer = null;
  }

  private detach(node: HTMLDivElement): void {
    this.destroy();
    node.removeEventListener('wheel', this.wheelHandler);
    node.removeEventListener('scrollend', this.wheelEndHandler);
    node.removeEventListener('touchstart', this.touchStartHandler);
    node.removeEventListener('touchmove', this.touchMoveHandler);
    node.removeEventListener('touchend', this.touchEndHandler);
    node.removeEventListener('touchcancel', this.touchEndHandler);
    node.removeEventListener('pointerdown', this.pointerStartHandler);
    node.removeEventListener('pointerup', this.pointerEndHandler);
    node.removeEventListener('pointercancel', this.pointerEndHandler);
    node.removeEventListener('keydown', this.keyHandler);
    node.removeEventListener('keyup', this.keyEndHandler);
  }
}
