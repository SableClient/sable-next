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

let swatch: CanvasRenderingContext2D | null | undefined;

function srgbChannels(color: string): [number, number, number] | undefined {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!swatch) return undefined;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const [red, green, blue] = swatch.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

/** `android.graphics.Color`'s packing, alpha forced opaque, as a signed Java int. */
export function opaqueArgb(color: string): number | undefined {
  const channels = srgbChannels(color);
  if (!channels) return undefined;
  const [red, green, blue] = channels.map((value) => Math.round(value) & 0xff);
  return 0xff000000 | (red << 16) | (green << 8) | blue | 0;
}

function syncWindowBackground(color: string | undefined, last: string): string {
  if (color === undefined || color === last) return last;
  const argb = opaqueArgb(color);
  if (argb === undefined) return last;
  void invoke('set_window_background', { color: argb }).catch(() => {
    // A missing command means an older shell; the keyboard band stays themed by Android.
  });
  return color;
}

const SAMPLE_INTERVAL_MS = 200;

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
  let sampledAt = 0;
  let lastTop = '';
  let lastBottom = '';
  let lastBackground = '';

  const sample = (): void => {
    frame = 0;
    sampledAt = performance.now();
    const x = Math.round(window.innerWidth / 2);
    lastTop = syncEdge('set_status_bar_light', readSurfaceColor(x, 1), lastTop);
    const bottom = readSurfaceColor(x, window.innerHeight - 1);
    lastBottom = syncEdge('set_navigation_bar_light', bottom, lastBottom);
    lastBackground = syncWindowBackground(bottom, lastBackground);
  };

  const runSample = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(sample);
  };
  const schedule = (): void => {
    if (performance.now() - sampledAt >= SAMPLE_INTERVAL_MS) runSample();
    window.clearTimeout(timer);
    timer = window.setTimeout(runSample, SAMPLE_INTERVAL_MS);
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
