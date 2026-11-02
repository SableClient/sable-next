import { MediaQuery } from 'svelte/reactivity';
import { BREAKPOINTS } from './breakpoints.js';

function usesAppLayout(wide: boolean, compactHeight: boolean): boolean {
  return wide && !compactHeight;
}

export class AppLayout {
  #wide = new MediaQuery(BREAKPOINTS.wide);
  #compactHeight = new MediaQuery(BREAKPOINTS.compactHeight);

  get current() {
    return usesAppLayout(this.#wide.current, this.compactHeight);
  }

  get compactHeight() {
    return this.#compactHeight.current;
  }

  drawerCovers(state: App.PageState): boolean {
    return !this.current && state.mobileDrawer === 'open';
  }
}

export function matchesAppLayout(): boolean {
  return usesAppLayout(
    window.matchMedia(BREAKPOINTS.wide).matches,
    window.matchMedia(BREAKPOINTS.compactHeight).matches
  );
}
