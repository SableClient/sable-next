export interface TimelineEntry<T> {
  key: string;
  value: T;
}

export interface TimelineRow<T> extends TimelineEntry<T> {
  index: number;
}

export interface TimelineWindowState {
  start: number;
  end: number;
  firstVisible: number | null;
  lastVisible: number | null;
  pinned: boolean;
  scrolling: boolean;
}

interface Options<T> {
  viewport: HTMLElement;
  canvas: HTMLElement;
  content: HTMLElement;
  render: (rows: readonly TimelineRow<T>[]) => Promise<void>;
  onChange: (state: TimelineWindowState) => void;
  onScroll: (delta: number) => void;
  canFollowLatest?: () => boolean;
  onInteraction?: () => void;
  isAnchor?: (value: T) => boolean;
  estimateSize?: (value: T) => number | undefined;
}

interface Measured {
  height: number;
  bucket: string;
}

interface BucketSizes {
  total: number;
  count: number;
}

interface Anchor {
  key: string;
  top: number;
}

interface Unmeasured {
  count: number;
  hint: number | undefined;
}

interface PrefixEstimate<T> {
  items: readonly TimelineEntry<T>[];
  start: number;
  measured: number;
  unmeasured: Map<string, Unmeasured>;
}

interface ViewSnapshot {
  start: number;
  end: number;
  anchors: Anchor[];
  offset: number;
}

const PAGE = 40;
const BUCKET_STEP = 40;
const QUIET_MS = 150;
const EPSILON = 0.5;

export class TimelineWindow<T> {
  private items: readonly TimelineEntry<T>[] = [];
  private pending: readonly TimelineEntry<T>[] | null = null;
  private rows: readonly TimelineRow<T>[] = [];
  private anchors: Anchor[] = [];
  private start = 0;
  private end = 0;
  private pinned = true;
  private ready = false;
  private touching = false;
  private active = false;
  private scrollingUp = false;
  private jumping = false;
  private rendering = false;
  private disposed = false;
  private height = 0;
  private top = 0;
  private readonly sizes = new Map<string, Measured>();
  private readonly buckets = new Map<string, BucketSizes>();
  private rowBuckets = new Map<string, string>();
  private sizeTotal = 0;
  private measuredHeight: number | null = null;
  private measuring = false;
  private prefix: PrefixEstimate<T> | null = null;
  private offset = 0;
  private scrollHeight = 0;
  private viewportHeight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void> = Promise.resolve();
  private renderTask: Promise<void> | null = null;
  private jumpVersion = 0;
  private missedDelta = 0;
  private readonly observer: ResizeObserver;
  private readonly listeners = new AbortController();

  constructor(private readonly options: Options<T>) {
    this.pinned = options.canFollowLatest?.() ?? true;
    const { viewport, canvas, content } = options;
    canvas.style.position = 'relative';
    content.style.position = 'absolute';
    content.style.bottom = '0';
    content.style.width = '100%';
    this.observer = new ResizeObserver(() => {
      this.layout();
    });
    this.observer.observe(viewport);
    this.observer.observe(content);
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      callback: (event: HTMLElementEventMap[K]) => void,
      capture = false
    ): void => {
      viewport.addEventListener(type, callback, {
        capture,
        passive: true,
        signal: this.listeners.signal,
      });
    };
    listen('scroll', () => {
      this.scrolled();
    });
    listen('scrollend', () => {
      this.scheduleSettle();
    });
    listen('wheel', (event) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      this.interact();
    });
    listen('touchstart', () => {
      this.touching = true;
      this.interact();
    });
    listen('pointerdown', () => {
      this.interact();
    });
    const release = (event: TouchEvent): void => {
      this.touching = event.touches.length > 0;
      this.scheduleSettle();
    };
    listen('touchend', release, true);
    listen('touchcancel', release, true);
    listen('keydown', (event) => {
      if (event.target !== viewport) return;
      if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End', ' '].includes(event.key))
        this.interact();
    });
    viewport.ownerDocument.addEventListener(
      'visibilitychange',
      () => {
        if (viewport.ownerDocument.visibilityState === 'hidden') {
          this.touching = false;
          this.scheduleSettle();
        } else this.layout();
      },
      { signal: this.listeners.signal }
    );
    viewport.ownerDocument.addEventListener(
      'input',
      (event) => {
        if (
          this.pinned &&
          !this.active &&
          event.target instanceof Node &&
          !viewport.contains(event.target)
        )
          this.writeOffset(viewport.scrollHeight - viewport.clientHeight);
      },
      { signal: this.listeners.signal }
    );
  }

  get state(): TimelineWindowState {
    return this.stateFor(this.visibleRows());
  }

  private stateFor(visible: readonly TimelineRow<T>[]): TimelineWindowState {
    return {
      start: this.start,
      end: this.end,
      firstVisible: visible[0]?.index ?? null,
      lastVisible: visible.at(-1)?.index ?? null,
      pinned: this.pinned,
      scrolling: this.active,
    };
  }

  get contentHeight(): number {
    this.scopeMeasurements();
    this.measuredHeight ??= this.options.content.getBoundingClientRect().height;
    return this.measuredHeight;
  }

  private scopeMeasurements(): void {
    if (this.measuring) return;
    this.measuring = true;
    queueMicrotask(() => {
      this.measuredHeight = null;
      this.measuring = false;
    });
  }

  update(items: readonly TimelineEntry<T>[]): Promise<void> {
    if (this.disposed || items === this.items || items === this.pending) return this.task;
    this.pending = items;
    if (this.active) return this.task;
    return this.drain();
  }

  holdAnchor(): void {
    this.pinned = false;
    this.publish(this.capture());
  }

  anchorKey(accept: (value: T) => boolean = () => true): string | null {
    const anchor = this.anchors.find(({ key }) => {
      const row = this.rows.find((candidate) => candidate.key === key);
      return row !== undefined && accept(row.value);
    });
    return anchor?.key ?? null;
  }

  async jumpTo(
    key: string | null,
    align: 'start' | 'center' = 'center',
    smooth = false,
    signal?: AbortSignal
  ): Promise<boolean> {
    const cancelled = () => this.disposed || signal?.aborted === true;
    if (cancelled()) return false;
    if (key !== null) {
      const index = (this.pending ?? this.items).findIndex((item) => item.key === key);
      if (index < 0) return false;
      if (
        !this.pending &&
        !this.rendering &&
        index >= this.start &&
        index < this.end &&
        !this.element(key)
      )
        return false;
    }
    const version = ++this.jumpVersion;
    this.active = false;
    this.touching = false;
    clearTimeout(this.timer);
    if (this.pending || this.rendering) await this.drain();
    if (version !== this.jumpVersion || cancelled()) return false;
    const index =
      key === null ? this.items.length - 1 : this.items.findIndex((item) => item.key === key);
    if (key !== null && index < 0) return false;
    const previous = {
      start: this.start,
      end: this.end,
      anchors: this.anchors.map((anchor) => ({ ...anchor })),
      offset: this.offset,
    };
    let leadIn = 0;
    if (index < this.start || index >= this.end) {
      if (smooth) leadIn = index >= this.end ? -1 : 1;
      await this.renderRange(
        Math.max(0, index - PAGE),
        Math.min(this.items.length, index + PAGE + 1)
      );
    }
    if (version !== this.jumpVersion || cancelled()) {
      if (!this.disposed && (this.state.scrolling || version === this.jumpVersion))
        await this.restore(previous);
      return false;
    }
    const row = key === null ? null : this.element(key);
    if (key !== null && !row) {
      if (this.start !== previous.start || this.end !== previous.end) await this.restore(previous);
      return false;
    }
    this.pinned = key === null && (this.options.canFollowLatest?.() ?? true);
    this.anchors = [];
    const viewport = this.options.viewport;
    this.setTop(Math.max(this.estimatePrefix(), viewport.clientHeight - this.contentHeight));
    this.setHeight(Math.max(this.top + this.contentHeight, viewport.clientHeight));
    if (this.pinned) this.setTop(this.height - this.contentHeight);
    const target = row
      ? viewport.scrollTop +
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        (align === 'center'
          ? Math.max(0, (viewport.clientHeight - row.getBoundingClientRect().height) / 2)
          : 0)
      : viewport.scrollHeight - viewport.clientHeight;
    this.jumping = smooth;
    this.active = smooth;
    this.missedDelta = 0;
    if (leadIn !== 0) {
      const room =
        leadIn < 0
          ? target - this.top
          : this.top + this.contentHeight - viewport.clientHeight - target;
      this.writeOffset(target + leadIn * Math.max(0, Math.min(viewport.clientHeight, room)));
    }
    this.writeOffset(target, smooth);
    if (!smooth && this.atEnd(1)) this.pinned = true;
    if (smooth) this.scheduleSettle();
    this.publish(this.capture());
    if (this.pending) this.scheduleSettle();
    return true;
  }

  destroy(): void {
    this.disposed = true;
    this.jumpVersion++;
    this.listeners.abort();
    this.observer.disconnect();
    clearTimeout(this.timer);
    this.pending = null;
    this.anchors = [];
  }

  private drain(): Promise<void> {
    if (this.disposed) return this.task;
    if (this.renderTask) return this.renderTask.then(() => this.drain());
    this.task = this.applyPending();
    return this.task;
  }

  private async restore(snapshot: ViewSnapshot): Promise<void> {
    if (this.disposed) return;
    this.offset = this.options.viewport.scrollTop;
    this.anchors = snapshot.anchors.map((anchor) => ({
      ...anchor,
      top: anchor.top - (this.offset - snapshot.offset),
    }));
    await this.renderRange(snapshot.start, snapshot.end);
    this.layout();
  }

  private async applyPending(): Promise<void> {
    while (this.pending && !this.active && !this.disposed) {
      const next = this.pending;
      const protectedKeys = this.protectedKeys();
      this.pending = null;
      const firstKey = this.rows[0]?.key;
      const first = firstKey ? next.findIndex((entry) => entry.key === firstKey) : -1;
      const anchorIndex = this.anchors
        .map((anchor) => next.findIndex((entry) => entry.key === anchor.key))
        .find((index) => index >= 0);
      this.items = next;
      const keys = new Set(next.map((entry) => entry.key));
      for (const [key, size] of this.sizes) {
        if (keys.has(key)) continue;
        this.sizes.delete(key);
        this.sizeTotal -= size.height;
        this.countBucket(size.bucket, -size.height);
      }
      if (this.pinned || !this.ready || (first < 0 && anchorIndex === undefined)) {
        this.start = Math.max(0, next.length - PAGE * 2);
        this.end = next.length;
      } else {
        this.start = Math.max(0, anchorIndex !== undefined ? anchorIndex - PAGE : first);
        this.end = Math.min(
          next.length,
          Math.max(this.start + PAGE * 2, (anchorIndex ?? first) + PAGE)
        );
      }
      for (const key of protectedKeys) {
        const index = next.findIndex((entry) => entry.key === key);
        if (index < 0) continue;
        this.start = Math.min(this.start, index);
        this.end = Math.max(this.end, index + 1);
      }
      await this.renderRange(this.start, this.end);
      this.layout();
      if (this.state.scrolling && !this.jumping) await this.extendWindow();
    }
  }

  private async renderRange(start: number, end: number): Promise<void> {
    this.start = start;
    this.end = end;
    this.rows = this.items
      .slice(start, end)
      .map((entry, index) => ({ ...entry, index: start + index }));
    this.rowBuckets = new Map(this.rows.map((row) => [row.key, this.bucketOf(row.value)]));
    this.rendering = true;
    try {
      this.renderTask = this.options.render(this.rows);
      await this.renderTask;
      if (!this.disposed) {
        this.observer.disconnect();
        this.observer.observe(this.options.viewport);
        this.observer.observe(this.options.content);
        for (const element of this.elements()) this.observer.observe(element);
      }
    } finally {
      this.rendering = false;
      this.renderTask = null;
    }
  }

  private element(key: string): HTMLElement | undefined {
    return this.elements().find((element) => element.dataset.timelineKey === key);
  }

  private elements(): HTMLElement[] {
    return Array.from(this.options.content.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement
    );
  }

  private visibleRows(): TimelineRow<T>[] {
    const bounds = this.options.viewport.getBoundingClientRect();
    const elements = this.elements();
    return this.rows.filter((_row, index) => {
      const rect = elements.at(index)?.getBoundingClientRect();
      return rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
  }

  private capture(): TimelineRow<T>[] {
    const viewport = this.options.viewport;
    const bounds = viewport.getBoundingClientRect();
    const visible: TimelineRow<T>[] = [];
    const entries = this.elements().flatMap((element, index) => {
      const row = this.rows.at(index);
      if (!row) return [];
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
      visible.push(row);
      if (this.options.isAnchor && !this.options.isAnchor(row.value)) return [];
      const top = element.firstElementChild?.getBoundingClientRect().top ?? rect.top;
      return [{ key: row.key, top: top - bounds.top, full: rect.top >= bounds.top }];
    });
    this.anchors = entries
      .filter((entry) => entry.full)
      .concat(entries.filter((entry) => !entry.full));
    return visible;
  }

  private setHeight(height: number, top?: number): void {
    height = Math.ceil(height);
    if (Math.abs(height - this.height) < EPSILON) {
      if (top !== undefined) this.setTop(top);
      return;
    }
    this.height = Math.max(0, height);
    this.options.canvas.style.height = `${this.height}px`;
    this.setTop(top ?? this.top);
  }

  private setTop(top: number): void {
    this.top = top;
    const bottom = `${this.height - this.contentHeight - top}px`;
    if (this.options.content.style.bottom !== bottom) this.options.content.style.bottom = bottom;
  }

  private bucketOf(value: T): string {
    const hint = this.options.estimateSize?.(value);
    return hint === undefined ? '' : String(Math.round(hint / BUCKET_STEP));
  }

  private countBucket(bucket: string, height: number): void {
    const sizes = this.buckets.get(bucket) ?? { total: 0, count: 0 };
    sizes.total += height;
    sizes.count += Math.sign(height) || 1;
    if (sizes.count <= 0) this.buckets.delete(bucket);
    else this.buckets.set(bucket, sizes);
  }

  private estimatedSize(bucket?: string, hint?: number): number {
    const sizes = bucket === undefined ? undefined : this.buckets.get(bucket);
    if (sizes && sizes.count > 0) return sizes.total / sizes.count;
    if (hint !== undefined) return hint;
    return this.sizes.size ? this.sizeTotal / this.sizes.size : 72;
  }

  private setSize(key: string, height: number, bucket: string): void {
    const previous = this.sizes.get(key);
    if (previous?.height === height && previous.bucket === bucket) return;
    this.sizeTotal += height - (previous?.height ?? 0);
    if (previous) this.countBucket(previous.bucket, -previous.height);
    this.countBucket(bucket, height);
    this.sizes.set(key, { height, bucket });
    if (previous === undefined) this.prefix = null;
  }

  private estimatePrefix(): number {
    let cache = this.prefix;
    if (cache === null || cache.items !== this.items || cache.start !== this.start) {
      cache = { items: this.items, start: this.start, measured: 0, unmeasured: new Map() };
      for (const item of this.items.slice(0, this.start)) {
        const size = this.sizes.get(item.key);
        if (size === undefined) {
          const bucket = this.bucketOf(item.value);
          const counted = cache.unmeasured.get(bucket);
          if (counted) counted.count += 1;
          else
            cache.unmeasured.set(bucket, {
              count: 1,
              hint: this.options.estimateSize?.(item.value),
            });
        } else cache.measured += size.height;
      }
      this.prefix = cache;
    }
    let total = cache.measured;
    for (const [bucket, { count, hint }] of cache.unmeasured)
      total += count * this.estimatedSize(bucket, hint);
    return total;
  }

  private writeOffset(offset: number, smooth = false): void {
    const viewport = this.options.viewport;
    const target = Math.max(0, Math.min(offset, viewport.scrollHeight - viewport.clientHeight));
    if (Math.abs(target - viewport.scrollTop) < EPSILON) return;
    if (smooth) viewport.scrollTo({ top: target, behavior: 'smooth' });
    else viewport.scrollTop = target;
    this.offset = viewport.scrollTop;
  }

  private atEnd(tolerance = EPSILON, offset?: number): boolean {
    if (this.options.canFollowLatest?.() === false) return false;
    const viewport = this.options.viewport;
    return (
      this.end === this.items.length &&
      (offset ?? viewport.scrollTop) >= viewport.scrollHeight - viewport.clientHeight - tolerance
    );
  }

  private trackMovement(): number {
    const viewport = this.options.viewport;
    const offset = viewport.scrollTop;
    const delta = offset - this.offset;
    this.offset = offset;
    if (delta === 0) return delta;
    this.scrollingUp = delta < 0;
    for (const anchor of this.anchors) anchor.top -= delta;
    const resized = this.ready && !this.active && viewport.clientHeight !== this.viewportHeight;
    if (!this.jumping)
      this.pinned =
        this.atEnd(delta > 0 ? 2 : EPSILON, offset) || (this.pinned && (delta > 0 || resized));
    return delta;
  }

  private layout(): void {
    if (this.disposed || this.rendering) return;
    const canFollowLatest = this.options.canFollowLatest?.() ?? true;
    if (!canFollowLatest) this.pinned = false;
    const viewport = this.options.viewport;
    const viewportHeight = viewport.clientHeight;
    const contentHeight = this.contentHeight;
    this.top = this.height - contentHeight - Number.parseFloat(this.options.content.style.bottom);
    if (this.active || !this.pinned) this.trackMovement();
    const elements = this.elements();
    for (const element of elements) {
      const key = element.dataset.timelineKey;
      const height = element.getBoundingClientRect().height;
      if (key && height > 0) this.setSize(key, height, this.rowBuckets.get(key) ?? '');
    }
    const contentFits =
      this.start === 0 && this.end === this.items.length && contentHeight <= viewportHeight;
    const reachedEnd =
      canFollowLatest &&
      (contentFits || (this.ready && viewportHeight > this.viewportHeight && this.atEnd(1)));
    if (reachedEnd) this.pinned = true;
    this.viewportHeight = viewportHeight;
    if (this.pinned && this.active && !this.jumping) {
      // Follow keyboard resizing without writing scrollTop during a gesture.
      this.setHeight(
        contentFits ? viewportHeight : Math.max(this.height, viewportHeight),
        (contentFits ? 0 : viewport.scrollTop) + viewportHeight - contentHeight
      );
    } else if (reachedEnd && this.active) {
      const height = contentFits ? viewportHeight : Math.max(this.height, viewportHeight);
      this.setHeight(height, height - contentHeight);
    } else if (this.pinned && !this.active) {
      const top = Math.max(this.estimatePrefix(), viewportHeight - contentHeight);
      const height = Math.ceil(Math.max(top + contentHeight, viewportHeight));
      this.setHeight(height, height - contentHeight);
      this.writeOffset(viewport.scrollHeight - viewportHeight);
    } else {
      const anchor = this.anchors
        .map((candidate) => ({
          ...candidate,
          element: elements.find((node) => node.dataset.timelineKey === candidate.key),
        }))
        .find((candidate) => candidate.element);
      let top = this.top;
      if (anchor?.element) {
        const element = anchor.element;
        const measuredTop =
          (element.firstElementChild ?? element).getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        top += anchor.top - measuredTop;
      }
      if (!this.active || (this.scrollingUp && !this.jumping && top < -EPSILON)) {
        const shift = Math.ceil(
          Math.max(this.estimatePrefix(), viewportHeight - contentHeight) - top
        );
        top += shift;
        this.setHeight(Math.max(top + contentHeight, viewportHeight), top);
        this.writeOffset(viewport.scrollTop + shift);
      } else this.setHeight(Math.max(top + contentHeight, viewportHeight), top);
      if (anchor?.element) {
        const element = anchor.element;
        const residual =
          anchor.top -
          ((element.firstElementChild ?? element).getBoundingClientRect().top -
            viewport.getBoundingClientRect().top);
        this.setTop(this.top + residual);
      }
    }
    this.offset = viewport.scrollTop;
    this.ready = true;
    this.scrollHeight = viewport.scrollHeight;
    this.publish(this.capture());
    this.flushMissedScroll();
  }

  private scrolled(): void {
    if (this.disposed) return;
    const viewport = this.options.viewport;
    const delta = this.trackMovement();
    if (delta === 0 && viewport.scrollHeight !== this.scrollHeight && this.atEnd(1)) {
      this.pinned = true;
      this.publish();
    }
    this.scrollHeight = viewport.scrollHeight;
    if (delta !== 0) {
      if (!this.jumping) {
        this.jumpVersion++;
        this.options.onInteraction?.();
      }
      this.active = true;
      this.scheduleSettle();
      if (this.rendering) {
        this.missedDelta += delta;
        return;
      }
      let visible: readonly TimelineRow<T>[] | undefined;
      if (this.scrollingUp && !this.jumping && this.top < -EPSILON) this.layout();
      else {
        visible = this.capture();
        this.publish(visible);
      }
      this.pursueScroll(delta, visible);
    }
  }

  private pursueScroll(delta: number, visible?: readonly TimelineRow<T>[]): void {
    if (this.jumping) return;
    this.options.onScroll(delta);
    void this.extendWindow(visible);
  }

  private flushMissedScroll(): void {
    const delta = this.missedDelta;
    if (delta === 0) return;
    this.missedDelta = 0;
    this.pursueScroll(delta);
  }

  private interact(): void {
    this.options.onInteraction?.();
    const wasActive = this.active;
    if (!wasActive) this.scrollingUp = false;
    this.jumpVersion++;
    this.jumping = false;
    this.scrolled();
    this.active = true;
    this.scheduleSettle();
    if (!wasActive) this.publish();
  }

  private scheduleSettle(): void {
    clearTimeout(this.timer);
    if (this.touching || this.disposed) return;
    this.timer = setTimeout(() => {
      const viewport = this.options.viewport;
      if (
        viewport.scrollTop < -1 ||
        viewport.scrollTop > viewport.scrollHeight - viewport.clientHeight + 1
      ) {
        this.scheduleSettle();
        return;
      }
      this.active = false;
      this.jumping = false;
      void this.settle();
    }, QUIET_MS);
  }

  private async settle(): Promise<void> {
    await this.drain();
    if (this.disposed || this.active) return;
    const visible = this.visibleRows();
    const first = visible.at(0)?.index;
    const last = visible.at(-1)?.index;
    if (this.protectedKeys().length === 0 && first !== undefined && last !== undefined) {
      const start = Math.max(0, first - PAGE);
      const end = Math.min(this.items.length, Math.max(start + PAGE * 2, last + PAGE + 1));
      if (start !== this.start || end !== this.end) await this.renderRange(start, end);
    }
    this.layout();
    if (this.pending) await this.drain();
  }

  private async extendWindow(visible?: readonly TimelineRow<T>[]): Promise<void> {
    if (this.rendering || this.disposed) return;
    const rows = visible ?? this.visibleRows();
    const first = rows.at(0)?.index;
    const last = rows.at(-1)?.index;
    if (first === undefined || last === undefined) {
      let top = 0;
      let index = 0;
      const offset = this.options.viewport.scrollTop;
      while (index < this.items.length - 1) {
        const entry = this.items[index];
        const size =
          this.sizes.get(entry.key)?.height ??
          this.estimatedSize(this.bucketOf(entry.value), this.options.estimateSize?.(entry.value));
        if (top + size > offset) break;
        top += size;
        index++;
      }
      await this.renderProtectedRange(
        Math.max(0, index - PAGE),
        Math.min(this.items.length, index + PAGE + 1)
      );
      this.setTop(this.estimatePrefix());
      this.layout();
      return;
    }
    if (
      (this.start === 0 || first - this.start >= PAGE / 2) &&
      (this.end === this.items.length || this.end - last >= PAGE / 2)
    )
      return;
    const start = Math.max(0, first - PAGE);
    const end = Math.min(this.items.length, Math.max(start + PAGE * 2, last + PAGE + 1));
    if (start === this.start && end === this.end) return;
    await this.renderProtectedRange(start, end);
    this.layout();
  }

  private async renderProtectedRange(start: number, end: number): Promise<void> {
    for (const key of this.protectedKeys()) {
      const index = this.items.findIndex((item) => item.key === key);
      if (index >= 0) {
        start = Math.min(start, index);
        end = Math.max(end, index + 1);
      }
    }
    if (start === this.start && end === this.end) return;
    await this.renderRange(start, end);
  }

  private protectedKeys(): string[] {
    const document = this.options.viewport.ownerDocument;
    const selection = document.getSelection();
    return this.elements()
      .filter(
        (element) =>
          element.contains(document.activeElement) ||
          (selection &&
            !selection.isCollapsed &&
            (element.contains(selection.anchorNode) || element.contains(selection.focusNode)))
      )
      .flatMap((element) => (element.dataset.timelineKey ? [element.dataset.timelineKey] : []));
  }

  private publish(visible?: readonly TimelineRow<T>[]): void {
    if (!this.disposed) this.options.onChange(visible ? this.stateFor(visible) : this.state);
  }
}
