import type { RelaunchOptions } from 'electron';

const EXTRACT_AND_RUN = '--appimage-extract-and-run';

/**
 * An AppImage runs from a mount that is gone once the app exits, so it is
 * relaunched from the image itself, which only starts again when told to
 * extract first (electron-userland/electron-builder#4650).
 */
export function relaunchOptions(
  argv: readonly string[],
  appImage: string | undefined,
  extra: readonly string[] = []
): RelaunchOptions {
  const args = [...new Set([...argv.slice(1), ...extra])];
  if (!appImage) return { args };
  return { execPath: appImage, args: [...new Set([...args, EXTRACT_AND_RUN])] };
}
