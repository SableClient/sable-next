import { invoke } from '@tauri-apps/api/core';

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
  return invoke<T>(command, bytes, { headers: encoded });
}
