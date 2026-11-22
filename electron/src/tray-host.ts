import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `null` when it cannot be asked, as on a system without gdbus. */
async function hostRegistered(): Promise<boolean | null> {
  try {
    const { stdout } = await run(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.kde.StatusNotifierWatcher',
        '--object-path',
        '/StatusNotifierWatcher',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.kde.StatusNotifierWatcher',
        'IsStatusNotifierHostRegistered',
      ],
      { encoding: 'utf8', timeout: 1000 }
    );
    return stdout.includes('true');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

/**
 * Chromium gives up on a tray icon created before the desktop has a tray to
 * put it in, which is the case when the app autostarts ahead of the shell.
 */
export async function waitForTrayHost(
  platform: NodeJS.Platform = process.platform,
  check: () => Promise<boolean | null> = hostRegistered,
  attempts = 30,
  delayMs = 1000
): Promise<void> {
  if (platform !== 'linux' && platform !== 'freebsd') return;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await check()) !== false) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
