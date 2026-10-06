import { Gunzip, gzipSync, strFromU8, strToU8 } from 'fflate';

import { MAX_THEME_FILE_BYTES } from './theme-file.js';

const encoded = new Map<string, string>();

export function compressCss(css: string): string {
  let value = encoded.get(css);
  if (value === undefined) {
    value = btoa(strFromU8(gzipSync(strToU8(css), { mtime: 0 }), true));
    if (encoded.size >= 64) encoded.clear();
    encoded.set(css, value);
  }
  return value;
}

export function decompressCss(value: string): string | null {
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const gunzip = new Gunzip((chunk) => {
      total += chunk.length;
      if (total > MAX_THEME_FILE_BYTES) {
        throw new Error('theme too large once inflated');
      }
      chunks.push(chunk);
    });
    gunzip.push(strToU8(atob(value), true), true);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return strFromU8(out);
  } catch {
    return null;
  }
}
