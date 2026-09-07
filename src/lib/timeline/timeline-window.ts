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
  isAnchor?: (value: T) => boolean;
}

interface Anchor {
  key: string;
  top: number;
}

interface ViewSnapshot {
  start: number;
  end: number;
  anchors: Anchor[];
  offset: number;
}

const PAGE = 40;
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
  private readonly sizes = new Map<string, number>();
  private offset = 0;
  private scrollHeight = 0;
  private viewportHeight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void> = Promise.resolve();
  private renderTask: Promise<void> | null = null;
  private jumpVersion = 0;
  private readonly observer: ResizeObserver;
  private readonly listeners = new AbortController();

  constructor(private readonly options: Options<T>) {
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
        if (viewport.ownerDocument.visibilityState === 'visible') this.layout();
      },
      { signal: this.listeners.signal }
    );
  }

  get state(): TimelineWindowState {
    const visible = this.visibleRows();
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
    return this.options.content.getBoundingClientRect().height;
  }

  update(items: readonly TimelineEntry<T>[]): Promise<void> {
    if (this.disposed || items === this.items || items === this.pending) return this.task;
    this.pending = items;
    if (this.active) return this.task;
    return this.drain();
  }

  async jumpTo(
    key: string | null,
    align: 'start' | 'center' = 'center',
    smooth = false
  ): Promise<boolean> {
    const version = ++this.jumpVersion;
    this.active = false;
    this.touching = false;
    clearTimeout(this.timer);
    if (this.pending || this.rendering) await this.drain();
    if (version !== this.jumpVersion || this.listeners.signal.aborted) return false;
    const index =
      key === null ? this.items.length - 1 : this.items.findIndex((item) => item.key === key);
    if (key !== null && index < 0) return false;
    const previous = {
      start: this.start,
      end: this.end,
      anchors: this.anchors.map((anchor) => ({ ...anchor })),
      offset: this.offset,
    };
    if (index < this.start || index >= this.end) {
      smooth = false;
      await this.renderRange(
        Math.max(0, index - PAGE),
        Math.min(this.items.length, index + PAGE + 1)
      );
    }
    if (version !== this.jumpVersion) {
      if (this.state.scrolling) await this.restore(previous);
      return false;
    }
    const row = key === null ? null : this.element(key);
    if (key !== null && !row) {
      if (this.start !== previous.start || this.end !== previous.end) await this.restore(previous);
      return false;
    }
    this.pinned = key === null;
    this.anchors = [];
    this.setTop(this.estimatePrefix());
    this.setHeight(Math.max(this.top + this.contentHeight, this.options.viewport.clientHeight));
    if (this.pinned) this.setTop(this.height - this.contentHeight);
    const viewport = this.options.viewport;
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
    this.writeOffset(target, smooth);
    if (smooth) this.scheduleSettle();
    this.capture();
    this.publish();
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
      for (const key of this.sizes.keys()) if (!keys.has(key)) this.sizes.delete(key);
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
    }
  }

  private async renderRange(start: number, end: number): Promise<void> {
    this.start = start;
    this.end = end;
    this.rows = this.items
      .slice(start, end)
      .map((entry, index) => ({ ...entry, index: start + index }));
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

  private capture(): void {
    const viewport = this.options.viewport;
    const bounds = viewport.getBoundingClientRect();
    const entries = this.elements().flatMap((element, index) => {
      const row = this.rows.at(index);
      if (!row || (this.options.isAnchor && !this.options.isAnchor(row.value))) return [];
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
      const top = (element.firstElementChild ?? element).getBoundingClientRect().top;
      return [{ key: row.key, top: top - bounds.top, full: rect.top >= bounds.top }];
    });
    this.anchors = entries
      .filter((entry) => entry.full)
      .concat(entries.filter((entry) => !entry.full));
  }

  private setHeight(height: number): void {
    height = Math.ceil(height);
    if (Math.abs(height - this.height) < EPSILON) return;
    this.height = Math.max(0, height);
    this.options.canvas.style.height = `${this.height}px`;
    this.setTop(this.top);
  }

  private setTop(top: number): void {
    this.top = top;
    this.options.content.style.bottom = `${this.height - this.contentHeight - top}px`;
  }

  private estimatedSize(): number {
    const measured = [...this.sizes.values()];
    return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : 72;
  }

  private estimatePrefix(): number {
    const estimate = this.estimatedSize();
    return this.items
      .slice(0, this.start)
      .reduce((sum, item) => sum + (this.sizes.get(item.key) ?? estimate), 0);
  }

  private writeOffset(offset: number, smooth = false): void {
    const viewport = this.options.viewport;
    const target = Math.max(0, Math.min(offset, viewport.scrollHeight - viewport.clientHeight));
    if (Math.abs(target - viewport.scrollTop) < EPSILON) return;
    if (smooth) viewport.scrollTo({ top: target, behavior: 'smooth' });
    else viewport.scrollTop = target;
    this.offset = viewport.scrollTop;
  }

  private atEnd(): boolean {
    const viewport = this.options.viewport;
    return (
      this.end === this.items.length &&
      viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - EPSILON
    );
  }

  private layout(): void {
    if (this.disposed || this.rendering) return;
    const viewport = this.options.viewport;
    this.top =
      this.height - this.contentHeight - Number.parseFloat(this.options.content.style.bottom);
    if (this.active) {
      const delta = viewport.scrollTop - this.offset;
      if (delta !== 0) this.scrollingUp = delta < 0;
      for (const anchor of this.anchors) anchor.top -= delta;
      if (!this.jumping && delta !== 0) this.pinned = this.atEnd();
      this.offset = viewport.scrollTop;
    }
    for (const element of this.elements()) {
      const key = element.dataset.timelineKey;
      const height = element.getBoundingClientRect().height;
      if (key && height > 0) this.sizes.set(key, height);
    }
    const reachedEndAfterResize =
      this.ready && viewport.clientHeight > this.viewportHeight && this.atEnd();
    if (reachedEndAfterResize) this.pinned = true;
    this.viewportHeight = viewport.clientHeight;
    if (reachedEndAfterResize && this.active) {
      this.setHeight(Math.max(this.height, viewport.clientHeight));
      this.setTop(this.height - this.contentHeight);
    } else if (this.pinned && !this.active) {
      this.setTop(Math.max(this.estimatePrefix(), viewport.clientHeight - this.contentHeight));
      this.setHeight(Math.max(this.top + this.contentHeight, viewport.clientHeight));
      this.setTop(this.height - this.contentHeight);
      this.writeOffset(viewport.scrollHeight - viewport.clientHeight);
    } else {
      const anchor = this.anchors
        .map((candidate) => ({ ...candidate, element: this.element(candidate.key) }))
        .find((candidate) => candidate.element);
      if (anchor?.element) {
        const element = anchor.element;
        const top =
          (element.firstElementChild ?? element).getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        this.setTop(this.top + anchor.top - top);
      }
      if (!this.active || (this.scrollingUp && !this.jumping && this.top < -EPSILON)) {
        const top = Math.max(this.estimatePrefix(), viewport.clientHeight - this.contentHeight);
        const target = viewport.scrollTop + top - this.top;
        this.setTop(top);
        this.setHeight(Math.max(this.top + this.contentHeight, viewport.clientHeight));
        this.writeOffset(target);
      }
      this.setHeight(Math.max(this.top + this.contentHeight, viewport.clientHeight));
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
    this.capture();
    this.publish();
  }

  private scrolled(): void {
    if (this.disposed) return;
    const viewport = this.options.viewport;
    const delta = viewport.scrollTop - this.offset;
    this.offset = viewport.scrollTop;
    if (delta === 0 && viewport.scrollHeight !== this.scrollHeight && this.atEnd()) {
      this.pinned = true;
      this.publish();
    }
    this.scrollHeight = viewport.scrollHeight;
    if (delta !== 0) {
      this.scrollingUp = delta < 0;
      for (const anchor of this.anchors) anchor.top -= delta;
      this.active = true;
      if (!this.jumping) {
        this.pinned = this.atEnd();
      }
      this.scheduleSettle();
      if (!this.rendering) {
        if (this.scrollingUp && !this.jumping && this.top < -EPSILON) this.layout();
        else {
          this.capture();
          this.publish();
        }
        if (!this.jumping) this.options.onScroll(delta);
        if (!this.jumping) void this.extendWindow();
      }
    }
  }

  private interact(): void {
    if (!this.active) this.scrollingUp = false;
    this.jumpVersion++;
    this.jumping = false;
    this.scrolled();
    this.active = true;
    this.scheduleSettle();
    this.publish();
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

  private async extendWindow(): Promise<void> {
    if (this.rendering || this.disposed) return;
    const visible = this.visibleRows();
    const first = visible.at(0)?.index;
    const last = visible.at(-1)?.index;
    if (first === undefined || last === undefined) {
      const estimate = this.estimatedSize();
      let top = 0;
      let index = 0;
      while (index < this.items.length - 1) {
        const size = this.sizes.get(this.items[index].key) ?? estimate;
        if (top + size > this.options.viewport.scrollTop) break;
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

  private publish(): void {
    if (!this.disposed) this.options.onChange(this.state);
  }
}
