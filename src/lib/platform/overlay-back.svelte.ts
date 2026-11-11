import { page } from '$app/state';
import { tick, untrack } from 'svelte';

import { leaveUnlessUnsaved } from '#lib/ui/unsaved-guard.js';
import { setPageState } from './page-state.js';

export function overlayBackDepth(state: App.PageState): number {
  return state.overlay ?? 0;
}

let pushed = 0;
let pushing = 0;
let queued = 0;
let popped: Promise<void> = Promise.resolve();
let released: number[] = [];
const POP_FALLBACK_MS = 250;

function popEntries(count: number): void {
  queued += count;
  if (queued > count) return;

  queueMicrotask(() => {
    const total = queued;
    queued = 0;
    if (total === 0) return;
    popped = new Promise((resolve) => {
      addEventListener(
        'popstate',
        () => {
          resolve();
        },
        { once: true }
      );
      setTimeout(resolve, POP_FALLBACK_MS);
    });
    history.go(-total);
  });
}

function unwindReleased(): void {
  let bottom = pushed;
  while (released.includes(bottom)) bottom -= 1;
  released = released.filter((depth) => depth < bottom);
  if (bottom === pushed) return;
  popEntries(pushed - bottom);
  pushed = bottom;
}

export async function afterOverlayPops(): Promise<void> {
  await tick();
  await Promise.resolve();
  await popped;
}

async function pushEntry(depth: number): Promise<boolean> {
  try {
    await setPageState({ ...untrack(() => page.state), overlay: depth });
    return true;
  } catch (error) {
    console.warn('[sable overlay] the back guard could not hold a history entry', error);
    return false;
  } finally {
    pushing -= 1;
  }
}

export function holdOverlayBack(open: () => boolean, close: () => void): void {
  let held = $state(0);
  let heldAt = '';
  let rearm: (() => void) | null = null;

  $effect(() => {
    if (!open()) return;

    let mine = true;
    const href = location.href;
    let depth = 0;
    const acquire = (): void => {
      const taken = (pushed += 1);
      depth = taken;
      if (queued > 0) {
        queued -= 1;
        held = taken;
        heldAt = location.href;
        return;
      }
      pushing += 1;
      void pushEntry(taken).then((ok) => {
        if (!ok) pushed = taken - 1;
        else if (mine) {
          held = taken;
          heldAt = location.href;
        } else popEntries(1);
      });
    };
    acquire();
    rearm = () => {
      void afterOverlayPops().then(() => {
        if (mine) acquire();
      });
    };

    return () => {
      const armed = held;
      mine = false;
      held = 0;
      rearm = null;
      if (armed === 0 || depth > pushed) return;
      if (location.href !== href) {
        pushed = depth - 1;
        return;
      }

      if (depth < pushed) {
        released.push(depth);
        return;
      }
      popEntries(1);
      pushed = depth - 1;
      unwindReleased();
    };
  });

  $effect(() => {
    const current = overlayBackDepth(page.state);
    if (pushing === 0 && current < pushed) {
      pushed = current;
      unwindReleased();
    }
    if (held > 0 && current < held) {
      held = 0;
      const restore = rearm;
      // A route change also drops the entry, but leaves the overlay meant to stay up.
      if (location.href !== heldAt) {
        pushed = current;
        restore?.();
        return;
      }
      leaveUnlessUnsaved(close, () => restore?.());
    }
  });
}
