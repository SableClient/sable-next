import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';

import { watchWindowFocus } from './window-decorations.js';

let nativeFocused: boolean | null = null;

const subscribe = createSubscriber((update) => {
  let stopped = false;
  let unlisten = (): void => {};
  void watchWindowFocus((focused) => {
    nativeFocused = focused;
    update();
  }).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  const offs = [
    on(window, 'focus', update),
    on(window, 'blur', update),
    on(document, 'visibilitychange', update),
  ];
  return () => {
    stopped = true;
    unlisten();
    nativeFocused = null;
    for (const off of offs) off();
  };
});

export const windowActivity = {
  get active(): boolean {
    subscribe();
    return document.visibilityState === 'visible' && (nativeFocused ?? document.hasFocus());
  },
};
