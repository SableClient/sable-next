import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export type InstallMethod = 'flatpak' | 'appimage' | 'deb' | 'rpm' | 'distribution' | 'unpacked';

export function installMethod(): InstallMethod {
  if (process.env.FLATPAK_ID) return 'flatpak';
  if (process.env.APPIMAGE) return 'appimage';
  try {
    const type = readFileSync(join(dirname(app.getAppPath()), 'package-type'), 'utf8').trim();
    // electron-builder marks its own deb and rpm; any other marker is a distribution's package.
    return type === 'deb' || type === 'rpm' ? type : 'distribution';
  } catch {
    return 'unpacked';
  }
}
