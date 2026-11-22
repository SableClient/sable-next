import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(() => Promise.resolve({ stdout: '' })),
  readFile: vi.fn(() => Promise.resolve('')),
  mkdir: vi.fn(),
  writeFile: vi.fn<(path: string, data: string) => Promise<void>>(),
}));

vi.mock('electron', () => ({
  app: { getName: () => 'Sable Nightly', getAppPath: () => '/opt/Sable Nightly' },
}));
vi.mock('node:fs/promises', () => mocks);
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.run,
  }),
}));

import { claimSchemes } from './linux-schemes';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.readFile.mockResolvedValue('');
});

test('Linux registers the renamed AppImage with the nightly callback scheme', async () => {
  vi.stubEnv('APPIMAGE', '/home/user/Sable Nightly.AppImage');
  await claimSchemes('/data/applications', 'moe.sable.next.nightly', ['moe.sable.next']);

  expect(mocks.writeFile).toHaveBeenCalledWith(
    join('/data/applications', 'moe.sable.next.nightly-handler.desktop'),
    expect.stringContaining('Name=Sable Nightly\nExec="/home/user/Sable Nightly.AppImage" %u\n')
  );
  expect(mocks.writeFile.mock.calls[0][1]).toContain('MimeType=x-scheme-handler/moe.sable.next;');
  expect(mocks.run).toHaveBeenCalledWith(
    'xdg-mime',
    ['default', 'moe.sable.next.nightly-handler.desktop', 'x-scheme-handler/moe.sable.next'],
    { encoding: 'utf8' }
  );
});

test('launching after an executable rename rewrites a stale handler', async () => {
  vi.stubEnv('APPIMAGE', '/home/user/Sable Nightly.AppImage');
  mocks.readFile.mockResolvedValue('Name=Sable\nExec="/home/user/sable.AppImage" %u\n');
  await claimSchemes('/data/applications', 'moe.sable.next.nightly', ['moe.sable.next']);
  expect(mocks.writeFile).toHaveBeenCalledOnce();
  expect(mocks.run).toHaveBeenCalledWith('update-desktop-database', ['/data/applications'], {
    encoding: 'utf8',
  });
});
