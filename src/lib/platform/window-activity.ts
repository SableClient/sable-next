import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';

import { watchWindowFocus } from './window-decorations.js';

let nativeFocused: boolean | null = null;
let pageShown = true;

const subscribe = createSubscriber((update) => {
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
    unlisten();
    nativeFocused = null;
    pageShown = true;
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
    return (
      pageShown && document.visibilityState === 'visible' && (nativeFocused ?? document.hasFocus())
    );
  },
};
