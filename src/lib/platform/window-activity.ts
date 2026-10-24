import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';

import { watchWindowFocus } from './window-decorations.js';

let nativeFocused: boolean | null = null;
let pageShown = true;
let wasActive = true;
let inactiveSince = 0;
let resumedAt = Number.NEGATIVE_INFINITY;
const RESUME_GRACE_MS = 8000;
const MIN_INACTIVE_MS = 30000;

function isActive(): boolean {
  return (
    pageShown && document.visibilityState === 'visible' && (nativeFocused ?? document.hasFocus())
  );
}

function noteActivity(): void {
  const now = isActive();
  if (now === wasActive) return;
  const at = performance.now();
  if (now && at - inactiveSince >= MIN_INACTIVE_MS) resumedAt = at;
  else if (!now) inactiveSince = at;
  wasActive = now;
}

const subscribe = createSubscriber((notify) => {
  let graceEnds: ReturnType<typeof setTimeout> | undefined;
  const update = (): void => {
    const before = resumedAt;
    noteActivity();
    if (resumedAt !== before) {
      clearTimeout(graceEnds);
      graceEnds = setTimeout(notify, RESUME_GRACE_MS);
    }
    notify();
  };
  let stopped = false;
  let unlisten = (): void => {};
  void watchWindowFocus((focused) => {
    if (stopped) return;
    nativeFocused = focused;
    update();
  })
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch(() => {
      if (stopped) return;
      nativeFocused = null;
      update();
    });
  const hide = () => {
    pageShown = false;
    update();
  };
  const show = () => {
    pageShown = true;
    update();
  };
  const offs = [
    on(window, 'focus', update),
    on(window, 'blur', update),
    on(window, 'pagehide', hide),
    on(window, 'pageshow', show),
    on(document, 'visibilitychange', update),
    on(document, 'freeze', hide),
    on(document, 'resume', show),
  ];
  return () => {
    stopped = true;
    clearTimeout(graceEnds);
    unlisten();
    nativeFocused = null;
    pageShown = true;
    for (const off of offs) off();
  };
});

const IDLE_AFTER_MS = 5 * 60_000;
let idle = false;
let lastInputAt = 0;

const subscribeIdle = createSubscriber((notify) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    const quiet = performance.now() - lastInputAt;
    if (quiet < IDLE_AFTER_MS) {
      timer = setTimeout(check, IDLE_AFTER_MS - quiet);
      return;
    }
    idle = true;
    notify();
  };
  const input = (): void => {
    lastInputAt = performance.now();
    if (!idle) return;
    idle = false;
    notify();
    timer = setTimeout(check, IDLE_AFTER_MS);
  };
  lastInputAt = performance.now();
  timer = setTimeout(check, IDLE_AFTER_MS);
  const offs = [
    on(window, 'pointermove', input, { passive: true }),
    on(window, 'pointerdown', input, { passive: true }),
    on(window, 'keydown', input, { passive: true }),
    on(window, 'wheel', input, { passive: true }),
  ];
  return () => {
    clearTimeout(timer);
    idle = false;
    for (const off of offs) off();
  };
});

export const windowActivity = {
  get visible(): boolean {
    subscribe();
    return pageShown && document.visibilityState === 'visible';
  },

  get active(): boolean {
    subscribe();
    return isActive();
  },

  get idle(): boolean {
    subscribeIdle();
    return idle;
  },

  get recentlyResumed(): boolean {
    subscribe();
    return performance.now() - resumedAt < RESUME_GRACE_MS;
  },
};
