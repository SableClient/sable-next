import { goto } from '$app/navigation';
import { page } from '$app/state';
import { untrack } from 'svelte';

export function overlayBackDepth(state: App.PageState): number {
  return state.overlay ?? 0;
}

let pushed = 0;
let pushing = 0;
let queued = 0;

function popEntries(count: number): void {
  queued += count;
  if (queued > count) return;

  queueMicrotask(() => {
    const total = queued;
    queued = 0;
    history.go(-total);
  });
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

  $effect(() => {
    if (!open()) return;

    let mine = true;
    const depth = (pushed += 1);
    pushing += 1;
    void pushEntry(depth).then((ok) => {
      if (!ok) pushed = depth - 1;
      else if (mine) held = depth;
      else popEntries(1);
    });

    return () => {
      const armed = held;
      mine = false;
      held = 0;
      if (armed === 0 || depth > pushed) return;

      popEntries(pushed - depth + 1);
      pushed = depth - 1;
    };
  });

  $effect(() => {
    const current = overlayBackDepth(page.state);
    if (pushing === 0 && current < pushed) pushed = current;
    if (held > 0 && current < held) close();
  });
}
