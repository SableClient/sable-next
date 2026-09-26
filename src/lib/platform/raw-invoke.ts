import { invoke } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { uint8ArrayToBase64 } from 'uint8array-extras';

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
    return invoke<T>(`${command}_base64`, {
      request: { bytes: uint8ArrayToBase64(bytes), headers: encoded },
    });
  }
  return invoke<T>(command, bytes, { headers: encoded });
}
