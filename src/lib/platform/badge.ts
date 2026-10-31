import { electronBridge } from './electron';
import { isNativeMobile } from './os';

const OVERLAY_SIZE = 32;

async function overlayIcon(count: number): Promise<string | null> {
  if (count === 0 || typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(OVERLAY_SIZE, OVERLAY_SIZE);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const half = OVERLAY_SIZE / 2;
  context.fillStyle = '#e02d2d';
  context.beginPath();
  context.arc(half, half, half, 0, Math.PI * 2);
  context.fill();
  const label = count > 9 ? '9+' : String(count);
  context.fillStyle = '#ffffff';
  context.font = `bold ${label.length > 1 ? 16 : 20}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, half, half + 1);
  const blob = await canvas.convertToBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

export async function setUnreadBadge(count: number): Promise<void> {
  const value = count > 0 ? count : null;

  const electron = electronBridge();
  if (electron) {
    const unread = value ?? 0;
    await electron.setBadge(
      unread,
      electron.platform === 'win32' ? await overlayIcon(unread) : null
    );
    return;
  }

  if (isNativeMobile() || !('setAppBadge' in navigator)) return;
  if (value === null) await navigator.clearAppBadge();
  else await navigator.setAppBadge(value);
}
