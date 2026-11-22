import { app } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installMethod } from './install-method';
import { desktopExec } from './linux-schemes';

export function autostartAvailable(): boolean {
  return app.isPackaged && installMethod() !== 'flatpak';
}

export async function setLaunchAtLogin(
  enabled: boolean,
  identifier: string,
  autostartDir: string
): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'freebsd') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const path = join(autostartDir, `${identifier}.desktop`);
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(autostartDir, { recursive: true });
  await writeFile(
    path,
    [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${app.getName()}`,
      `Exec=${desktopExec(identifier)}`,
      'Terminal=false',
      '',
    ].join('\n')
  );
}
