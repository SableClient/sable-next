import { SvelteSet } from 'svelte/reactivity';

import { CoreError } from '#src/transport';

const MAX_RETRIES = 10;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 120_000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;

export interface JoinQueueTarget {
  roomId: string;
  run: () => Promise<boolean>;
}

export function retryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof CoreError) || error.detail.code !== 'rate_limited') return null;
  const hinted = error.detail.retry_after_ms;
  const delay = hinted ?? Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return Math.min(Math.max(delay, MIN_DELAY_MS), MAX_DELAY_MS);
}

export class JoinQueue {
  running = $state(false);
  waiting = $state(false);
  done = $state(0);
  failed = $state(0);
  total = $state(0);
  joined = new SvelteSet<string>();

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- add runs inside an effect and probes it, so a reactive set would re-run that effect
  #seen = new Set<string>();
  #queue: JoinQueueTarget[] = [];
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;

  constructor(private readonly onFailed: (roomId: string, error: unknown) => void) {}

  get idle(): boolean {
    return !this.running;
  }

  add(targets: readonly JoinQueueTarget[]): void {
    for (const target of targets) {
      if (this.#seen.has(target.roomId)) continue;
      this.#seen.add(target.roomId);
      this.#queue.push(target);
      this.total += 1;
    }
    if (!this.running && this.#queue.length > 0) {
      this.running = true;
      void this.#drain(this.#generation);
    }
  }

  cancel(): void {
    this.#generation += 1;
    this.#queue = [];
    this.#seen.clear();
    this.running = false;
    this.waiting = false;
    this.done = 0;
    this.failed = 0;
    this.total = 0;
    this.joined.clear();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#wake?.();
    this.#wake = null;
  }

  async #drain(generation: number): Promise<void> {
    while (generation === this.#generation) {
      const target = this.#queue.shift();
      if (target === undefined) break;
      await this.#attempt(target, generation);
    }
    if (generation === this.#generation) this.running = false;
  }

  async #attempt(target: JoinQueueTarget, generation: number): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const joined = await target.run();
        if (generation !== this.#generation) return;
        if (joined) this.joined.add(target.roomId);
        this.done += 1;
        return;
      } catch (error) {
        if (generation !== this.#generation) return;
        const delay = attempt < MAX_RETRIES ? retryDelay(error, attempt) : null;
        if (delay === null) {
          this.failed += 1;
          this.onFailed(target.roomId, error);
          return;
        }
        this.waiting = true;
        await this.#sleep(delay);
        if (generation !== this.#generation) return;
        this.waiting = false;
      }
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#wake = null;
        resolve();
      }, ms);
    });
  }
}
