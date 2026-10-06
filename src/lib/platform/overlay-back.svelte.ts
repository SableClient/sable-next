import { goto } from '$app/navigation';
import { page } from '$app/state';
import { tick, untrack } from 'svelte';

import { leaveUnlessUnsaved } from '#lib/ui/unsaved-guard.js';

export function overlayBackDepth(state: App.PageState): number {
  return state.overlay ?? 0;
}

let pushed = 0;
let pushing = 0;
let queued = 0;
let popped: Promise<void> = Promise.resolve();
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

export async function afterOverlayPops(): Promise<void> {
  await tick();
  await Promise.resolve();
  await popped;
}

async function pushEntry(depth: number): Promise<boolean> {
  try {
    await goto('', {
      shallow: true,
      state: { ...untrack(() => page.state), overlay: depth },
    });
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
        return;
      }
      pushing += 1;
      void pushEntry(taken).then((ok) => {
        if (!ok) pushed = taken - 1;
        else if (mine) held = taken;
        else popEntries(1);
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

      popEntries(pushed - depth + 1);
      pushed = depth - 1;
    };
  });

  $effect(() => {
    const current = overlayBackDepth(page.state);
    if (pushing === 0 && current < pushed) pushed = current;
    if (held > 0 && current < held) {
      held = 0;
      const restore = rearm;
      leaveUnlessUnsaved(close, () => restore?.());
    }
  });
}
