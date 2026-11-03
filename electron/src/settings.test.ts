import { expect, test } from 'vitest';

import { sanitize } from './settings';

test('a partial file preserves valid settings and supplies defaults', () => {
  expect(sanitize({ hardwareAcceleration: false, updateChannel: 'nightly' })).toEqual({
    hardwareAcceleration: false,
    hardwareVideoEncode: true,
    hardwareVideoDecode: true,
    smoothScrolling: true,
    webRtcIpPolicy: 'default',
    updateChannel: 'nightly',
    customTitleBar: process.platform === 'win32',
    launchAtLogin: false,
    startMinimized: false,
  });
});

test('invalid fields recover independently of valid fields', () => {
  const settings = sanitize({
    smoothScrolling: false,
    webRtcIpPolicy: 'unsafe',
    hardwareAcceleration: 'false',
    customTitleBar: true,
  });
  expect(settings.smoothScrolling).toBe(false);
  expect(settings.hardwareAcceleration).toBe(true);
  expect(settings.webRtcIpPolicy).toBe('default');
  expect(settings.customTitleBar).toBe(true);
});

test('non-object inputs return independent default settings', () => {
  const first = sanitize(null);
  first.smoothScrolling = false;
  expect(sanitize('invalid').smoothScrolling).toBe(true);
});

test('an array is read as a file with no settings', () => {
  expect(sanitize(['updateChannel'])).toEqual(sanitize({}));
});

test('the combined video acceleration setting carries over to encode and decode', () => {
  const settings = sanitize({ hardwareVideoAcceleration: false, hardwareVideoDecode: true });
  expect(settings.hardwareVideoEncode).toBe(false);
  expect(settings.hardwareVideoDecode).toBe(true);
});
