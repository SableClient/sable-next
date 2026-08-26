import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { on } from 'svelte/events';

const TRANSPARENT = /^(transparent$|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))/;

function channel(value: number): number {
  const part = value / 255;
  return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, so the threshold matches how the icons will read. */
export function isLightColor(color: string): boolean {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return true;
  const [red, green, blue] = parts.map(Number);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue) > 0.179;
}

// First non-transparent background painted at (x, y): the surface sitting under
// a system bar is the one whose contrast the icons must match, and it is often
// not the body's — a drawer or a sheet owns that strip instead.
function readSurfaceColor(x: number, y: number): string | undefined {
  let el = document.elementFromPoint(x, y);
  while (el) {
    const background = getComputedStyle(el).backgroundColor;
    if (background && !TRANSPARENT.test(background)) return background;
    el = el.parentElement;
  }
  return undefined;
}

type BarCommand = 'set_status_bar_light' | 'set_navigation_bar_light';

function syncEdge(
  command: BarCommand,
  color: string | undefined,
  last: string | undefined
): string {
  if (color === undefined) return last ?? '';
  if (color === last) return last;
  void invoke(command, { light: isLightColor(color) }).catch(() => {
    // A missing command means an older shell; the bars keep their icons.
  });
  return color;
}

/**
 * Android leaves the bars transparent and the webview paints under them, so the
 * colour is already whatever the page draws; only the icon contrast is ours to
 * set. `Window.setStatusBarColor` cannot help — it is a no-op from API 35.
 *
 * The two bars can sit over different surfaces, so each is sampled and pushed
 * on its own. Returns the cleanup for the observers and debounce timers.
 */
export function startSystemBarSync(): () => void {
  if (!isTauri() || osType() !== 'android') return () => {};

  let frame = 0;
  let timer = 0;
  let lastTop = '';
  let lastBottom = '';

  const sample = (): void => {
    frame = 0;
    const x = Math.round(window.innerWidth / 2);
    lastTop = syncEdge('set_status_bar_light', readSurfaceColor(x, 1), lastTop);
    lastBottom = syncEdge(
      'set_navigation_bar_light',
      readSurfaceColor(x, window.innerHeight - 1),
      lastBottom
    );
  };

  const runSample = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sample);
  };
  const schedule = (): void => {
    runSample();
    window.clearTimeout(timer);
    timer = window.setTimeout(runSample, 120);
  };

  runSample();
  const observer = new MutationObserver(schedule);
  // childList = navigation and overlays; class/style = theme swaps, recolors.
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  const stopResize = on(window, 'resize', schedule);

  return () => {
    window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    stopResize();
  };
}
