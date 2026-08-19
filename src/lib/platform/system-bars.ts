import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

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

/**
 * Android leaves the bars transparent and the webview paints under them, so the
 * colour is already whatever the page draws; only the icon contrast is ours to
 * set. `Window.setStatusBarColor` cannot help — it is a no-op from API 35.
 */
export async function syncSystemBarIcons(): Promise<void> {
  if (!isTauri() || osType() !== 'android') return;
  const background = getComputedStyle(document.body).backgroundColor;
  if (TRANSPARENT.test(background)) return;
  try {
    await invoke('set_system_bars_light', { light: isLightColor(background) });
  } catch {
    // A missing command means an older shell; the bars keep their icons.
  }
}
