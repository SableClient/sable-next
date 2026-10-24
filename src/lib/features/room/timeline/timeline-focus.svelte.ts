import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineEntry, TimelineWindow } from '#lib/timeline/timeline-window.js';
import type { TimelinePagination } from './timeline-pagination.svelte.js';

interface FocusDependencies<T> {
  timeline: () => RoomTimeline;
  viewport: () => HTMLElement | null;
  entries: () => readonly TimelineEntry<T>[];
  target: () => string | null;
  history: TimelinePagination;
  requestFuture: () => Promise<void>;
  canRequestFuture?: () => boolean;
}

export class TimelineFocus<T> {
  filling = $state(false);
  #navigation: AbortController | null = null;

  constructor(private readonly deps: FocusDependencies<T>) {}

  cancel(): void {
    this.#navigation?.abort();
  }

  async #fillViewport(engine: TimelineWindow<T>, current: () => boolean): Promise<void> {
    while (
      current() &&
      this.deps.timeline().mode.kind === 'focused' &&
      this.deps.timeline().error === null
    ) {
      const node = this.deps.viewport();
      if (!node || node.scrollHeight - node.clientHeight > 1) break;
      if (
        this.deps.timeline().forwardPagination === 'loading' ||
        this.deps.timeline().backwardPagination === 'loading'
      )
        break;
      const before = this.deps.timeline().itemCount;
      if (this.deps.timeline().forwardPagination !== 'end') {
        if (this.deps.canRequestFuture?.() === false) break;
        await this.deps.requestFuture();
      } else if (
        !this.deps.history.exhausted &&
        this.deps.timeline().backwardPagination !== 'end'
      ) {
        const end = await this.deps.history.requestHistory();
        if (!current()) break;
        this.deps.history.exhausted = end;
      } else break;
      if (!current() || this.deps.timeline().error !== null) break;
      if (this.deps.timeline().itemCount === before) break;
      await engine.update(this.deps.entries());
      await new Promise(requestAnimationFrame);
    }
  }
  async position(
    engine: TimelineWindow<T>,
    target: string,
    key: string,
    smooth: boolean
  ): Promise<void> {
    this.#navigation?.abort();
    const navigation = new AbortController();
    this.#navigation = navigation;
    const mode = this.deps.timeline().mode;
    const current = () =>
      !navigation.signal.aborted &&
      this.deps.target() === target &&
      this.deps.timeline().mode === mode;
    const viewport = this.deps.viewport();
    const needsFill =
      this.deps.timeline().mode.kind === 'focused' &&
      viewport !== null &&
      viewport.scrollHeight - viewport.clientHeight <= 1;
    this.filling = true;
    try {
      const moved = await engine.jumpTo(key, 'center', smooth && !needsFill, navigation.signal);
      if (!moved || !current() || !needsFill) return;
      await this.#fillViewport(engine, current);
      if (current() && this.deps.timeline().error === null)
        await engine.jumpTo(key, 'center', smooth, navigation.signal);
    } catch (error) {
      console.warn('[sable timeline] positioning the focused event failed', error);
    } finally {
      if (this.#navigation === navigation) this.filling = false;
    }
  }
}
