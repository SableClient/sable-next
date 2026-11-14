import { isNativeMobile } from './os.js';

/** WKWebView can come back from the background zoomed in, and the app has its own text size setting. */
export function lockNativeZoom(): void {
  if (!isNativeMobile()) return;
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content += ', maximum-scale=1, user-scalable=no';
}
