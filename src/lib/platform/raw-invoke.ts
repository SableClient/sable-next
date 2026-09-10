import { invoke } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

/**
 * A `Vec<u8>` argument would be marshalled as a JSON array of numbers, so the
 * bytes ride the raw request body and the metadata the headers. A header value
 * holds no character above U+00FF, so every value is percent-encoded and the
 * Rust `decode_header` helper decodes it.
 */
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
    return invoke<T>(`${command}_base64`, { bytes: base64(bytes), headers: encoded });
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
