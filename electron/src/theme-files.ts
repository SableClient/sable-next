import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { ThemeFileSnapshot } from '../../src/lib/platform/file-dialog-types';

const MAX_THEME_FILE_BYTES = 1024 * 1024;

export async function readThemeFile(
  path: string,
  since: number | null
): Promise<ThemeFileSnapshot | null> {
  if (extname(path).toLowerCase() !== '.css') throw new Error('Not a .css file');
  const info = await stat(path);
  const modified = Math.trunc(info.mtimeMs);
  if (modified === since) return null;
  if (info.size > MAX_THEME_FILE_BYTES) throw new Error('Theme file too large');
  return { path, modified, css: await readFile(path, 'utf8') };
}
