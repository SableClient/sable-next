import { clamp } from '#lib/clamp.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { on } from 'svelte/events';
import { wcagLuminance } from 'culori/fn';
import type { Rgb } from 'culori';

import { rgb } from '#lib/culori.js';

let swatch: CanvasRenderingContext2D | null | undefined;

function parseColor(color: string): Rgb | undefined {
  const parsed = rgb(color);
  if (parsed || !CSS.supports('color', color)) return parsed;
  swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!swatch) return undefined;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, alpha] = Array.from(swatch.getImageData(0, 0, 1, 1).data, (value) => value / 255);
  return { mode: 'rgb', r, g, b, alpha };
}

/** WCAG relative luminance, so the threshold matches how the icons will read. */
export function isLightColor(color: string): boolean {
  const parsed = parseColor(color);
  return !parsed || wcagLuminance(parsed) > 0.179;
}

// First non-transparent background at (x, y): the surface under a bar sets the icon contrast, and may be a drawer or sheet.
function readSurfaceColor(x: number, y: number): string | undefined {
  let el = document.elementFromPoint(x, y);
  while (el) {
    const background = getComputedStyle(el).backgroundColor;
    if (background && parseColor(background)?.alpha !== 0) return background;
    el = el.parentElement;
  }
  return undefined;
}

/** `android.graphics.Color`'s packing, alpha forced opaque, as a signed Java int. */
export function opaqueArgb(color: string): number | undefined {
  const parsed = parseColor(color);
  if (!parsed) return undefined;
  const [red, green, blue] = [parsed.r, parsed.g, parsed.b].map((value) =>
    Math.round(clamp(value, 0, 1) * 255)
  );
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

export function setSystemBarsHidden(hidden: boolean): void {
  if (!isTauri() || (osType() !== 'android' && osType() !== 'ios')) return;
  void invoke('set_system_bars_hidden', { hidden }).catch((error: unknown) => {
    console.debug('[sable window] system bars not toggled', error);
  });
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
 * Samples each bar's surface and sets the icon contrast, since Android leaves the bars transparent. Returns the cleanup.
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
