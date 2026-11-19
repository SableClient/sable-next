import { expect, test } from 'vitest';

import { relaunchOptions } from './relaunch';

test('relaunches with the same arguments and any new ones, once each', () => {
  expect(relaunchOptions(['/opt/sable', '--flag'], undefined, ['--flag', '--new'])).toEqual({
    args: ['--flag', '--new'],
  });
});

test('relaunches an AppImage from the image and tells it to extract', () => {
  const first = relaunchOptions(['/tmp/.mount_abc/sable', '--flag'], '/home/u/Sable.AppImage');
  expect(first).toEqual({
    execPath: '/home/u/Sable.AppImage',
    args: ['--flag', '--appimage-extract-and-run'],
  });
  expect(
    relaunchOptions(['/tmp/.mount_def/sable', ...(first.args ?? [])], '/home/u/Sable.AppImage')
  ).toEqual(first);
});
