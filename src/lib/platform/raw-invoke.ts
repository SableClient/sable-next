import { invoke } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

export function rawInvoke<T>(
  command: string,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
): Promise<T> {
  const encoded = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, encodeURIComponent(value)])
  );
  if (
    typeof window !== 'undefined' &&
    osType() === 'android' &&
    (command === 'send_attachment' || command === 'upload_media')
  ) {
    return invoke<T>(`${command}_base64`, { request: { bytes: base64(bytes), headers: encoded } });
  }
  return invoke<T>(command, bytes, { headers: encoded });
}

function base64(bytes: Uint8Array<ArrayBuffer>): string {
  let text = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(text);
}
